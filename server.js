import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe"; // ← added (kept)

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

if (!HUBSPOT_TOKEN) {
  console.error("Missing HUBSPOT_TOKEN");
  process.exit(1);
}

app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*"
      ? true
      : ALLOWED_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

// tiny req log
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

// ---------- HubSpot helpers ----------
async function getContactByEmail(email) {
  const resp = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    properties: ["email", "firstname", "lastname"],
    limit: 1,
  });
  return resp.data?.results?.[0] || null;
}

async function markContactAsSubscriberByEmail(email) {
  if (!email) return null;
  try {
    const contact = await getContactByEmail(email);
    if (!contact?.id) return null;

    await hs.patch(`/crm/v3/objects/contacts/${contact.id}`, {
      properties: {
        jobtitle: "1",
      },
    });
    return contact.id;
  } catch (err) {
    console.error("markContactAsSubscriberByEmail error:", err.response?.data || err.message || err);
    return null;
  }
}

// Prefer v3 associations; fall back to v4 if needed
async function getAssociatedNoteIds(contactId) {
  // v3
  try {
    const v3Resp = await hs.get(`/crm/v3/objects/contacts/${contactId}/associations/notes`, {
      params: { limit: 100 },
    });
    const v3Results = v3Resp.data?.results || [];
    if (v3Results.length > 0) {
      return v3Results.map((r) => r.id).filter(Boolean);
    }
  } catch (err) {
    console.error("getAssociatedNoteIds v3 error:", err.response?.data || err.message);
  }

  // v4 fallback
  try {
    const v4Resp = await hs.get(`/crm/v4/objects/contacts/${contactId}/associations/notes`);
    const v4Results = v4Resp.data?.results || [];
    if (v4Results.length > 0) {
      return v4Results.map((r) => r.toObjectId).filter(Boolean);
    }
  } catch (err) {
    console.error("getAssociatedNoteIds v4 error:", err.response?.data || err.message);
  }

  return [];
}

async function getNotesByIds(ids) {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  if (unique.length === 0) return [];

  const results = [];
  for (const id of unique) {
    try {
      const resp = await hs.get(`/crm/v3/objects/notes/${id}`, {
        params: { properties: "hs_note_body,hs_timestamp" },
      });
      if (resp.data) {
        results.push({
          id: resp.data.id,
          body: resp.data.properties?.hs_note_body || "",
          timestamp: resp.data.properties?.hs_timestamp || "",
        });
      }
    } catch (err) {
      console.error("getNotesByIds error for id", id, ":", err.response?.data || err.message);
    }
  }
  return results;
}

async function deleteExistingNotes(contactId) {
  // Use v3 list first:
  try {
    const noteIds = await getAssociatedNoteIds(contactId);
    for (const id of noteIds) {
      try {
        await hs.delete(`/crm/v3/objects/notes/${id}`);
      } catch (err) {
        console.error("deleteExistingNotes delete error:", id, err.response?.data || err.message);
      }
    }
    return noteIds.length;
  } catch (err) {
    console.error("deleteExistingNotes error:", err.response?.data || err.message);
    return 0;
  }
}

// ------------- Vehicles handlers ----------------
async function handleGetVehicles(req, res) {
  try {
    const email = String(req.query.email || "").trim();
    const debug = req.query.debug === "true";

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ error: "contact_not_found" });
    }

    const noteIds = await getAssociatedNoteIds(contact.id);
    const notes = await getNotesByIds(noteIds);

    // Each note is a JSON array or object; parse and flatten
    const vehicles = [];
    const parsedPreview = [];

    for (const note of notes) {
      if (!note.body) continue;

      try {
        const parsed = JSON.parse(note.body);
        parsedPreview.push(parsed);

        if (Array.isArray(parsed)) {
          for (const v of parsed) {
            const obj = parseVehicleFromJson(v);
            if (obj) vehicles.push(obj);
          }
        } else {
          const obj = parseVehicleFromJson(parsed);
          if (obj) vehicles.push(obj);
        }
      } catch (err) {
        console.error("Vehicle note parse error:", err?.message || err);
      }
    }

    const envelope = { vehicles, debug: debug ? { email, contactId: contact.id, noteIds, notes, parsedPreview } : undefined };

    return res.json(envelope);
  } catch (err) {
    console.error("GET /vehicles error:", err.response?.data || err.message || err);
    return res.status(500).json({ error: "server_error" });
  }
}

function parseVehicleFromJson(v) {
  if (!v || typeof v !== "object") return null;
  const make = v.make || v.Make || v.MAKE || "";
  const model = v.model || v.Model || v.MODEL || "";
  const year = v.year || v.Year || v.YEAR || "";
  const color = v.color || v.Color || v.COLOR || "";
  const plate = v.licensePlate || v.plate || v.Plate || v.License || v.LICENSE || "";

  const name = v.name || `${year} ${make} ${model}`.trim();
  return {
    id: v.id || undefined,
    make,
    model,
    year,
    color,
    plate,
    name,
  };
}

async function createNote(body) {
  const resp = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: body,
      hs_timestamp: Date.now(),
    },
  });
  return resp.data?.id;
}

// v3 association to contact
async function associateNoteToContact(noteId, contactId) {
  await hs.put(`/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`);
}

// Create NEW note(s) but first delete existing ones
async function handleSyncVehicles(req, res) {
  try {
    const { email, vehicles } = req.body || {};
    if (!email || !Array.isArray(vehicles)) {
      return res.status(400).json({ error: "email and vehicles[] are required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact) return res.status(404).json({ error: "contact_not_found" });

    // STEP 1: delete current notes for that contact
    const removed = await deleteExistingNotes(contact.id);

    // STEP 2: add a single JSON array note with the updated vehicles
    const body = JSON.stringify(
      vehicles.map((v) => ({
        name: v.name || "",
        plate: v.plate || "",
        color: v.color || "",
      }))
    );

    const noteId = await createNote(body);
    if (noteId) {
      await associateNoteToContact(noteId, contact.id);
    }

    return res.json({
      success: true,
      removed,
      noteId,
    });
  } catch (err) {
    console.error("POST /vehicles/sync error:", err.response?.data || err.message || err);
    return res.status(500).json({ error: "server_error" });
  }
}

app.post("/api/hubspot/vehicles/sync", handleSyncVehicles);

app.get("/vehicles", handleGetVehicles);
app.post("/vehicles/sync", handleSyncVehicles);


// === NEW: Create/Upsert HubSpot Contact ================================
app.post("/contacts", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const firstName = req.body?.firstName?.toString() ?? "";
    const lastName  = req.body?.lastName?.toString() ?? "";
    const phone     = req.body?.phone?.toString() ?? "";

    if (!email) {
      return res.status(400).json({ success: false, message: "email is required" });
    }

    // 1) Find existing contact by email
    const existing = await getContactByEmail(email);

    // 2) Update or Create
    if (existing?.id) {
      const contactId = existing.id;
      const props = {};
      if (email)     props.email = email;
      if (firstName) props.firstname = firstName;
      if (lastName)  props.lastname  = lastName;
      if (phone)     props.phone     = phone;

      if (Object.keys(props).length > 0) {
        await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties: props });
      }

      return res.status(200).json({
        success: true,
        message: "Contact updated",
        contactId,
      });
    } else {
      // Create new contact
      const createResp = await hs.post("/crm/v3/objects/contacts", {
        properties: {
          email,
          firstname: firstName,
          lastname: lastName,
          phone,
        },
      });

      return res.status(201).json({
        success: true,
        message: "Contact created",
        contactId: createResp.data?.id,
      });
    }
  } catch (err) {
    console.error("POST /contacts error:", err.response?.data || err.message || err);
    return res.status(500).json({
      success: false,
      message: "server_error",
      detail: err.response?.data || err.message || String(err),
    });
  }
});

// ======== Mark Contact as Subscriber (Job Title = 1) =========
app.post("/contacts/mark-subscriber", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    if (!email) {
      return res.status(400).json({ success: false, message: "email is required" });
    }

    const contactId = await markContactAsSubscriberByEmail(email);
    if (!contactId) {
      return res.status(404).json({ success: false, message: "contact_not_found" });
    }

    return res.json({ success: true, contactId });
  } catch (err) {
    console.error("POST /contacts/mark-subscriber error:", err.response?.data || err.message || err);
    return res.status(500).json({
      success: false,
      message: "server_error",
      detail: err.response?.data || err.message || String(err),
    });
  }
});

// ========== Contact Status (job title) ===========
app.get("/contacts/status", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    if (!email) return res.status(400).json({ jobTitle: null });

    const searchResp = await hs.post("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["jobtitle"],
      limit: 1,
    });

    const contact = searchResp.data?.results?.[0];
    const jobTitle = contact?.properties?.jobtitle ?? null;
    return res.json({ jobTitle });
  } catch (err) {
    console.error("GET /contacts/status error:", err.response?.data || err.message);
    return res.status(500).json({ jobTitle: null });
  }
});

// ================= REFILL BOOKING (CREATE HUBSPOT TASK) ===================
app.post("/refills/book", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const serviceLocation = String(req.body?.serviceLocation || "").trim();
    const scheduledAt = String(req.body?.scheduledAt || "").trim();
    const vehicle = req.body?.vehicle || {};

    if (!email || !serviceLocation || !scheduledAt || !vehicle) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ error: "contact_not_found" });
    }

    const subjectParts = [
      "Refill Booking",
      vehicle.plate ? `- ${vehicle.plate}` : (vehicle.name ? `- ${vehicle.name}` : "")
    ];
    const subject = subjectParts.join(" ").trim() || "Refill Booking";

    const lines = [
      vehicle.name ? `Vehicle: ${vehicle.name}` : null,
      vehicle.plate ? `Plate: ${vehicle.plate}` : null,
      vehicle.color ? `Color: ${vehicle.color}` : null,
      serviceLocation ? `Location: ${serviceLocation}` : null,
      scheduledAt ? `Scheduled For: ${scheduledAt}` : null,
    ].filter(Boolean);

    const body = lines.join("\n");

    let timestamp = Date.now();
    const parsed = Date.parse(scheduledAt);
    if (!Number.isNaN(parsed)) {
      timestamp = parsed;
    }

    const taskResp = await hs.post("/crm/v3/objects/tasks", {
      properties: {
        hs_task_subject: subject,
        hs_task_body: body,
        hs_timestamp: timestamp,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: "MEDIUM",
      },
    });

    const taskId = taskResp.data?.id;
    if (taskId && contact.id) {
      try {
        await hs.put(
          `/crm/v3/objects/tasks/${taskId}/associations/contacts/${contact.id}/task_to_contact`
        );
      } catch (assocErr) {
        console.error(
          "associate task->contact error:",
          assocErr.response?.data || assocErr.message || assocErr
        );
      }
    }

    return res.json({
      success: true,
      taskId: taskId || null,
      contactId: contact.id || null,
    });
  } catch (err) {
    console.error("POST /refills/book error:", err.response?.data || err.message || err);
    return res.status(500).json({
      success: false,
      error: "server_error",
      detail: err.response?.data || err.message || String(err),
    });
  }
});

// ========================== STRIPE (ADDED/UPDATED) ===============================

const PORTAL_RETURN_URL = process.env.PORTAL_RETURN_URL || "https://gasmeuppgh.com";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" })
  : null;

// Helper: find or create Stripe Customer by email, and keep name in sync
async function findOrCreateStripeCustomer(email, name) {
  if (!stripe) throw new Error("Stripe not configured");
  if (!email) throw new Error("email is required for Stripe customer");

  const search = await stripe.customers.search({
    query: `email:\\"${email}\\"`,
    limit: 1,
  });

  const existing = search.data?.[0];
  if (existing) {
    return existing.id;
  }

  const customer = await stripe.customers.create({
    email,
    name,
  });
  return customer.id;
}

// Create Billing Portal session
app.post("/stripe/create-portal-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: { message: "Stripe not configured" } });
    }

    const email = String(req.body?.email || "").trim();
    if (!email) {
      return res.status(400).json({ error: { message: "email is required" } });
    }

    const customerId = await findOrCreateStripeCustomer(email, email);

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: PORTAL_RETURN_URL,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-portal-session error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ error: { message: err?.message || "stripe_error" } });
  }
});

// You might already have something like this for Setup Intents or payment methods
app.post("/stripe/init-setup", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: { message: "Stripe not configured" } });
    }

    const email = String(req.body?.email || "").trim();
    if (!email) {
      return res.status(400).json({ error: { message: "email is required" } });
    }

    const customerId = await findOrCreateStripeCustomer(email, email);
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
    });

    return res.json({
      clientSecret: setupIntent.client_secret,
    });
  } catch (err) {
    console.error("init-setup error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ error: { message: err?.message || "stripe_error" } });
  }
});

// ======================== END STRIPE (ADDED/UPDATED) =============================



// JSON 404
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.originalUrl })
);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
