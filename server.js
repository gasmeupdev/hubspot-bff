import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe"; // ← Stripe support

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

if (!HUBSPOT_TOKEN) {
  console.error("Missing HUBSPOT_TOKEN");
  process.exit(1);
}

// ---------------- EXPRESS / CORS SETUP ----------------
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
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
    if (!contact || !contact.id) {
      console.warn("markContactAsSubscriberByEmail: no contact found for email", email);
      return null;
    }

    const contactId = contact.id;
    await hs.patch(`/crm/v3/objects/contacts/${contactId}`, {
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
    const r3 = await hs.get(`/crm/v3/objects/contacts/${contactId}/associations/notes?limit=100`);
    const ids3 = (r3.data?.results || []).map((x) => x.id).filter(Boolean);
    if (ids3.length) return ids3;
  } catch (e) {
    // ignore, try v4
  }
  // v4
  const r4 = await hs.get(`/crm/v4/objects/contacts/${contactId}/associations/notes?limit=100`);
  const ids4 = (r4.data?.results || []).map((x) => (x.to && x.to.id ? x.to.id : null)).filter(Boolean);
  return ids4;
}

async function getNotesByIds(ids) {
  if (!ids?.length) return [];
  const resp = await hs.post("/crm/v3/objects/notes/batch/read", {
    properties: ["hs_note_body", "hs_timestamp"],
    inputs: ids.map((id) => ({ id })),
  });
  return resp.data?.results || [];
}

async function deleteExistingNotes(contactId) {
  const ids = await getAssociatedNoteIds(contactId);
  if (!ids.length) return 0;

  try {
    // batch archive if available
    await hs.post("/crm/v3/objects/notes/batch/archive", {
      inputs: ids.map((id) => ({ id })),
    });
    return ids.length;
  } catch (err) {
    // fallback: delete one-by-one
    let deleted = 0;
    for (const id of ids) {
      try {
        await hs.delete(`/crm/v3/objects/notes/${id}`);
        deleted++;
      } catch {
        // continue
      }
    }
    return deleted;
  }
}

// ---------- Vehicle extraction ----------
function normalize(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = ["make", "model", "year", "color", "licensePlate", "plate", "name"];
  const result = {};

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const val = obj[key];
      if (val != null) {
        result[key] = String(val);
      }
    }
  }

  if (!result.name) {
    const parts = [];
    if (result.year) parts.push(result.year);
    if (result.make) parts.push(result.make);
    if (result.model) parts.push(result.model);
    result.name = parts.join(" ").trim() || "Vehicle";
  }

  if (!result.plate && result.licensePlate) {
    result.plate = result.licensePlate;
  }

  if (!result.plate) {
    result.plate = "—";
  }

  if (!result.color) {
    result.color = "—";
  }

  return result;
}

function extractVehiclesFromBody(body) {
  if (!body || typeof body !== "string") return [];

  const tryParseAny = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  // 1) direct parse
  let parsed = tryParseAny(body);

  // 2) if HTML/text-wrapped, slice the outermost {...} or [...] and try again
  if (!parsed) {
    const firstBrace = body.indexOf("{");
    const lastBrace = body.lastIndexOf("}");
    const firstBracket = body.indexOf("[");
    const lastBracket = body.lastIndexOf("]");
    const hasObject = firstBrace >= 0 && lastBrace > firstBrace;
    const hasArray = firstBracket >= 0 && lastBracket > firstBracket;

    if (hasArray && (!hasObject || firstBracket < firstBrace)) {
      parsed = tryParseAny(body.slice(firstBracket, lastBracket + 1));
    } else if (hasObject) {
      parsed = tryParseAny(body.slice(firstBrace, lastBrace + 1));
    }
  }

  const out = [];

  if (!parsed) return out;

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const n = normalize(item);
      if (n) out.push(n);
    }
  } else {
    // maybe {vehicles: [...]}
    if (Array.isArray(parsed.vehicles)) {
      for (const v of parsed.vehicles) {
        const n = normalize(v);
        if (n) out.push(n);
      }
      return out;
    }
    // single object vehicle
    const n = normalize(parsed);
    if (n) out.push(n);
  }

  return out;
}

// ---------- Routes ----------
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

    const vehicles = [];
    const raw = [];

    for (const n of notes) {
      const body = n.properties?.hs_note_body || "";
      const arr = extractVehiclesFromBody(body);
      if (arr.length) vehicles.push(...arr);
      if (debug) raw.push({ id: n.id, bodyPreview: body.slice(0, 300) });
    }

    const payload = { vehicles };
    if (debug)
      payload.debug = {
        email,
        contactId: contact.id,
        noteCount: notes.length,
        parsedCount: vehicles.length,
        raw,
      };

    return res.json(payload);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("GET /vehicles error:", data);
    return res.status(status).json({ error: "server_error", details: data });
  }
}

// Create a note; ALWAYS ensure hs_note_body is a plain JSON string.
// This guarantees one JSON block per HubSpot note.
async function createNote(body) {
  // Always store a plain JSON string (one vehicle per note).
  const textBody = typeof body === "string" ? body : JSON.stringify(body);
  const resp = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: textBody,
      hs_timestamp: Date.now(),
    },
  });
  return resp.data?.id;
}

// v3 association to contact
async function associateNoteToContact(noteId, contactId) {
  await hs.put(
    `/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`
  );
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

    // STEP 2: create new notes — ONE note per vehicle
    let created = 0;
    for (const v of vehicles) {
      const payload = JSON.stringify({
        name: v.name || `${v.make || ""} ${v.model || ""}`.trim(),
        make: v.make || "",
        model: v.model || "",
        year: v.year || "",
        color: v.color || "",
        licensePlate: v.licensePlate || v.plate || "",
      });
      const noteId = await createNote(payload);
      await associateNoteToContact(noteId, contact.id);
      created++;
    }

    return res.status(200).json({ ok: true, deleted: removed, created });
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("POST /vehicles/sync error:", data);
    return res.status(status).json({ error: "server_error", details: data });
  }
}

// ---- route bindings ----
app.get("/api/hubspot/vehicles", handleGetVehicles);
app.post("/api/hubspot/vehicles/sync", handleSyncVehicles);

app.get("/vehicles", handleGetVehicles);
app.post("/vehicles/sync", handleSyncVehicles);

// === NEW: Create/Upsert HubSpot Contact ================================
app.post("/contacts", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const firstName = req.body?.firstName?.toString() ?? "";
    const lastName = req.body?.lastName?.toString() ?? "";
    const phone = req.body?.phone?.toString() ?? "";

    if (!email) {
      return res.status(400).json({ success: false, message: "email is required" });
    }

    // 1) Look for existing contact by email
    const searchResp = await hs.post("/crm/v3/objects/contacts/search", {
      filterGroups: [
        {
          filters: [{ propertyName: "email", operator: "EQ", value: email }],
        },
      ],
      properties: ["email", "firstname", "lastname", "phone"],
      limit: 1,
    });
    const existing = searchResp.data?.results?.[0];

    const props = {
      email,
      firstname: firstName,
      lastname: lastName,
      phone,
    };

    if (existing && existing.id) {
      const contactId = existing.id;
      await hs.patch(`/crm/v3/objects/contacts/${contactId}`, {
        properties: props,
      });
      return res.json({ success: true, mode: "updated", id: contactId });
    }

    // 2) Create new
    const createResp = await hs.post("/crm/v3/objects/contacts", {
      properties: props,
    });

    return res.json({
      success: true,
      mode: "created",
      id: createResp.data?.id,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const details = err.response?.data || err.message;
    console.error("POST /contacts error:", details);
    return res.status(status).json({ success: false, error: details });
  }
});

// GET /contacts/status?email=someone@example.com
app.get("/contacts/status", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const searchResp = await hs.post("/crm/v3/objects/contacts/search", {
      filterGroups: [
        {
          filters: [{ propertyName: "email", operator: "EQ", value: email }],
        },
      ],
      properties: ["email", "firstname", "lastname", "phone", "jobtitle"],
      limit: 1,
    });

    const contact = searchResp.data?.results?.[0] || null;
    if (!contact) {
      return res.status(404).json({ error: "not_found" });
    }

    const props = contact.properties || {};
    return res.json({
      email: props.email || email,
      firstName: props.firstname || "",
      lastName: props.lastname || "",
      phone: props.phone || "",
      jobTitle: props.jobtitle || "",
    });
  } catch (err) {
    const status = err.response?.status || 500;
    console.error("GET /contacts/status error:", err.response?.data || err.message);
    return res.status(status).json({ error: "server_error" });
  }
});

// ========================== REFILL BOOKING / TASK CREATION ===============================

/**
 * POST /refills/book
 * Body: { email, serviceLocation, scheduledAt, vehicle: { name, plate, color } }
 * Creates a HubSpot CRM task associated to the contact representing this refill request.
 */
app.post("/refills/book", async (req, res) => {
  try {
    const email = (req.body?.email ?? "").toString().trim();
    const serviceLocation = (req.body?.serviceLocation ?? "").toString().trim();
    const scheduledAt = (req.body?.scheduledAt ?? "").toString().trim();
    const vehicle = req.body?.vehicle || {};

    if (!email || !serviceLocation || !scheduledAt) {
      return res
        .status(400)
        .json({ error: "email, serviceLocation, and scheduledAt are required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ error: "contact_not_found" });
    }

    const vehicleName = (vehicle.name ?? "").toString().trim();
    const vehiclePlate = (vehicle.plate ?? "").toString().trim();
    const vehicleColor = (vehicle.color ?? "").toString().trim();

    const subject =
      vehicleName || vehiclePlate
        ? `Refill request - ${vehicleName || vehiclePlate}`
        : "Refill request";

    const bodyLines = [
      "New refill request from iOS app.",
      "",
      `Service location: ${serviceLocation}`,
      `Scheduled for: ${scheduledAt}`,
      "",
      `Vehicle: ${vehicleName || "N/A"}`,
      `Plate: ${vehiclePlate || "N/A"}`,
      `Color: ${vehicleColor || "N/A"}`,
    ];
    const taskBody = bodyLines.join("\n");

    const taskResp = await hs.post("/crm/v3/objects/tasks", {
      properties: {
        hs_timestamp: scheduledAt, // ISO8601 is accepted
        hs_task_subject: subject,
        hs_task_body: taskBody,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: "HIGH",
        hs_task_type: "TODO",
      },
      associations: [
        {
          to: { id: contact.id },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: "task_to_contact",
            },
          ],
        },
      ],
    });

    const taskId = taskResp.data?.id;
    return res.status(201).json({ ok: true, taskId });
  } catch (err) {
    const status = err.response?.status || 500;
    const details = err.response?.data || err.message;
    console.error("POST /refills/book error:", details);
    return res.status(status).json({ error: "server_error", details });
  }
});

// ========================== STRIPE (BILLING & PAYMENTS) ===============================

const PORTAL_RETURN_URL = process.env.PORTAL_RETURN_URL || "https://gasmeuppgh.com";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" })
  : null;

// Helper: find or create Stripe Customer by email, and keep name in sync
async function getOrCreateStripeCustomerByEmail(email, name) {
  if (!stripe) throw new Error("Stripe not configured");

  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) {
    const customer = existing.data[0];
    // Update name when provided
    if (name && name !== customer.name) {
      await stripe.customers.update(customer.id, { name });
    }
    return customer;
  }

  // No customer found, create a new one
  return await stripe.customers.create({
    email,
    name: name || undefined,
    metadata: {
      hubspot_email: email,
    },
  });
}

app.get("/stripe/publishable-key", (_req, res) => {
  if (!STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "Missing STRIPE_PUBLISHABLE_KEY" });
  }
  return res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

// Create a Stripe Billing Portal session for managing payment methods
app.post("/stripe/create-portal-session", async (req, res) => {
  try {
    if (!stripe) {
      return res
        .status(500)
        .json({ error: { message: "Stripe not configured (missing STRIPE_SECRET_KEY)" } });
    }

    const email = (req.body?.email ?? "").toString().trim();
    const name = (req.body?.name ?? "").toString().trim();
    if (!email) {
      return res.status(400).json({ error: { message: "email required" } });
    }

    const customer = await getOrCreateStripeCustomerByEmail(email, name);

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: PORTAL_RETURN_URL,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-portal-session error:", err?.response?.data || err?.message || err);
    return res
      .status(500)
      .json({ error: { message: err?.message || "portal_error" } });
  }
});

// One-off charge via PaymentIntent. Used by "Become Subscriber" flow.
app.post("/stripe/init-subscription-payment", async (req, res) => {
  try {
    if (!stripe) {
      return res
        .status(500)
        .json({ error: { message: "Stripe not configured (missing STRIPE_SECRET_KEY)" } });
    }

    const email = (req.body?.email ?? "").toString().trim();
    const name = (req.body?.name ?? "").toString().trim();
    if (!email) return res.status(400).json({ error: { message: "email required" } });

    const customer = await getOrCreateStripeCustomerByEmail(email, name);

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2023-10-16" }
    );

    const amountCents = Number.isFinite(req.body?.amountCents)
      ? req.body.amountCents
      : 2500; // default $25

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      customer: customer.id,
      automatic_payment_methods: { enabled: true },
      setup_future_usage: "off_session",
      metadata: { hubspot_email: email, app_source: "ios_signup" },
    });

    // Mark HubSpot contact as subscriber (jobtitle = "1") after payment intent creation
    await markContactAsSubscriberByEmail(email);

    return res.json({
      email,
      customerId: customer.id,
      ephemeralKeySecret: ephemeralKey.secret,
      paymentIntentClientSecret: paymentIntent.client_secret,
    });
  } catch (err) {
    console.error("init-subscription-payment error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ error: { message: err?.message || "stripe_error" } });
  }
});

// SetupIntent flow to save card first (optional)
app.post("/stripe/init-setup", async (req, res) => {
  try {
    if (!stripe) {
      return res
        .status(500)
        .json({ error: { message: "Stripe not configured (missing STRIPE_SECRET_KEY)" } });
    }

    const email = (req.body?.email ?? "").toString().trim();
    const name = (req.body?.name ?? "").toString().trim();
    if (!email) return res.status(400).json({ error: { message: "email required" } });

    const customer = await getOrCreateStripeCustomerByEmail(email, name);

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2023-10-16" }
    );

    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      usage: "off_session",
      payment_method_types: ["card", "link"],
      metadata: { hubspot_email: email, app_source: "ios_setup" },
    });

    return res.json({
      email,
      customerId: customer.id,
      ephemeralKeySecret: ephemeralKey.secret,
      setupIntentClientSecret: setupIntent.client_secret,
    });
  } catch (err) {
    console.error("init-setup error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ error: { message: err?.message || "stripe_error" } });
  }
});

// ======================== END STRIPE =============================

// JSON 404
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.originalUrl })
);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
