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
    console.warn("batch archive failed, falling back to single delete", err.response?.data || err.message);
  }

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

// ---------- Task helpers for refill history ----------
async function getAssociatedTaskIds(contactId) {
  // v3
  try {
    const r3 = await hs.get(`/crm/v3/objects/contacts/${contactId}/associations/tasks?limit=100`);
    const ids3 = (r3.data?.results || []).map((x) => x.id).filter(Boolean);
    if (ids3.length) return ids3;
  } catch (e) {
    // ignore, try v4
  }
  // v4
  const r4 = await hs.get(`/crm/v4/objects/contacts/${contactId}/associations/tasks?limit=100`);
  const ids4 = (r4.data?.results || [])
    .map((x) => (x.to && x.to.id ? x.to.id : null))
    .filter(Boolean);
  return ids4;
}

async function getTasksByIds(ids) {
  if (!ids?.length) return [];
  const resp = await hs.post("/crm/v3/objects/tasks/batch/read", {
    properties: ["hs_task_subject", "hs_task_body", "hs_timestamp"],
    inputs: ids.map((id) => ({ id })),
  });
  return resp.data?.results || [];
}

// Parse status code from task subject like "(0) Refill request - Truck".
// If no code prefix is present, defaults to "0" (in progress / not started).
function parseRefillTask(subjectRaw) {
  const subject = (subjectRaw || "").toString();
  const match = subject.match(/^\((\d)\)\s*/);
  let code = "0";
  if (match && ["0", "1", "2"].includes(match[1])) {
    code = match[1];
  }
  const cleanSubject = match ? subject.slice(match[0].length) : subject;

  let status = "in_progress";
  if (code === "1") status = "completed";
  else if (code === "2") status = "canceled";

  return { code, status, cleanSubject };
}

// ---------- Vehicle extraction ----------
function normalize(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = ["make", "model", "year", "color", "licensePlate", "plate", "name"];
  const result = {};

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = String(obj[key] ?? "").trim();
    }
  }

  // Support licensePlate vs plate
  if (result.licensePlate && !result.plate) {
    result.plate = result.licensePlate;
  }
  if (result.plate && !result.licensePlate) {
    result.licensePlate = result.plate;
  }

  return result;
}

// Extract vehicles from a JSON string in hs_note_body
function extractVehiclesFromNoteBody(body) {
  if (!body || typeof body !== "string") return [];

  const matches = body.match(/\{[\s\S]*?\}/g) || [];
  const vehicles = [];

  for (const jsonLike of matches) {
    try {
      const obj = JSON.parse(jsonLike);
      const norm = normalize(obj);
      if (!norm) continue;

      const name = norm.name || `${norm.make || ""} ${norm.model || ""}`.trim();
      const vehicle = {
        name: name || "Vehicle",
        make: norm.make || "",
        model: norm.model || "",
        year: norm.year || "",
        color: norm.color || "",
        licensePlate: norm.licensePlate || norm.plate || "",
      };

      // If we at least have a name or plate, accept it
      if (vehicle.name || vehicle.licensePlate) {
        vehicles.push(vehicle);
      }
    } catch {
      // ignore malformed JSON
    }
  }

  return vehicles;
}

// Collapse all vehicles to a simple list (avoid duplicates by string key)
function mergeVehicles(arrays) {
  const map = new Map();

  for (const list of arrays) {
    for (const v of list) {
      const key = `${v.name}|${v.make}|${v.model}|${v.year}|${v.color}|${v.licensePlate}`;
      if (!map.has(key)) {
        map.set(key, v);
      }
    }
  }

  return Array.from(map.values());
}

// ----------------- VEHICLES ENDPOINTS -----------------

// GET /api/hubspot/vehicles?contactId=xxx
//   Reads notes associated with contact, extracts JSON vehicles from hs_note_body
app.get("/api/hubspot/vehicles", async (req, res) => {
  try {
    const contactId = String(req.query.contactId || "").trim();
    if (!contactId) {
      return res.status(400).json({ error: "contactId is required" });
    }

    const noteIds = await getAssociatedNoteIds(contactId);
    if (!noteIds.length) {
      return res.json({ vehicles: [] });
    }

    const notes = await getNotesByIds(noteIds);
    const rawVehicles = notes.map((note) =>
      extractVehiclesFromNoteBody(note.properties?.hs_note_body || "")
    );
    const vehicles = mergeVehicles(rawVehicles);

    return res.json({ vehicles });
  } catch (err) {
    console.error("GET /api/hubspot/vehicles error:", err.response?.data || err.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// POST /api/hubspot/vehicles/sync
// Body: { email, vehicles: [ { name, make, model, year, color, licensePlate } ] }
// Behavior: Delete old notes, then create one NOTE per vehicle with JSON in hs_note_body
app.post("/api/hubspot/vehicles/sync", async (req, res) => {
  try {
    const email = (req.body?.email || "").toString().trim();
    const vehicles = Array.isArray(req.body?.vehicles) ? req.body.vehicles : [];

    if (!email) {
      return res.status(400).json({ success: false, error: "email is required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ success: false, error: "contact_not_found" });
    }

    const contactId = contact.id;

    // delete existing notes
    await deleteExistingNotes(contactId);

    // create one NOTE per vehicle
    for (const v of vehicles) {
      const norm = normalize(v);
      if (!norm) continue;

      const noteBody = JSON.stringify({
        name: norm.name || "",
        make: norm.make || "",
        model: norm.model || "",
        year: norm.year || "",
        color: norm.color || "",
        licensePlate: norm.licensePlate || norm.plate || "",
      });

      const noteResp = await hs.post("/crm/v3/objects/notes", {
        properties: {
          hs_note_body: noteBody,
        },
      });

      const noteId = noteResp.data?.id;
      if (!noteId) continue;

      // associate note to contact (v3 association)
      await hs.put(
        `/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`,
        {}
      );
    }

    return res.json({ success: true });
  } catch (err) {
    const status = err.response?.status || 500;
    const details = err.response?.data || err.message;
    console.error("POST /api/hubspot/vehicles/sync error:", details);
    return res.status(status).json({ success: false, error: details });
  }
});

// Convenience endpoint that accepts email instead of contactId
// GET /vehicles?email=someone@example.com
app.get("/vehicles", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ error: "contact_not_found" });
    }

    req.query.contactId = contact.id;
    return app._router.handle(req, res, () => {});
  } catch (err) {
    console.error("GET /vehicles error:", err.response?.data || err.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// POST /vehicles/sync
// Body: { email, vehicles: [...] }
app.post("/vehicles/sync", async (req, res) => {
  try {
    const email = (req.body?.email || "").toString().trim();
    const vehicles = Array.isArray(req.body?.vehicles) ? req.body.vehicles : [];

    if (!email) {
      return res.status(400).json({ success: false, error: "email is required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ success: false, error: "contact_not_found" });
    }

    const contactId = contact.id;

    // delete existing notes
    await deleteExistingNotes(contactId);

    // create one NOTE per vehicle
    for (const v of vehicles) {
      const norm = normalize(v);
      if (!norm) continue;

      const noteBody = JSON.stringify({
        name: norm.name || "",
        make: norm.make || "",
        model: norm.model || "",
        year: norm.year || "",
        color: norm.color || "",
        licensePlate: norm.licensePlate || norm.plate || "",
      });

      const noteResp = await hs.post("/crm/v3/objects/notes", {
        properties: {
          hs_note_body: noteBody,
        },
      });

      const noteId = noteResp.data?.id;
      if (!noteId) continue;

      await hs.put(
        `/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`,
        {}
      );
    }

    return res.json({ success: true });
  } catch (err) {
    const status = err.response?.status || 500;
    const details = err.response?.data || err.message;
    console.error("POST /vehicles/sync error:", details);
    return res.status(status).json({ success: false, error: details });
  }
});

// ----------------- CONTACT CREATION / STATUS -----------------

// POST /contacts
// Body: { email, firstname, lastname, phone }
app.post("/contacts", async (req, res) => {
  try {
    const { email, firstname, lastname, phone } = req.body || {};

    if (!email) {
      return res.status(400).json({ success: false, error: "email is required" });
    }

    const existing = await getContactByEmail(email);
    if (existing && existing.id) {
      return res.json({ success: true, id: existing.id, created: false });
    }

    const resp = await hs.post("/crm/v3/objects/contacts", {
      properties: {
        email,
        firstname: firstname || "",
        lastname: lastname || "",
        phone: phone || "",
      },
    });

    return res.status(201).json({ success: true, id: resp.data?.id, created: true });
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

    // Pull extended properties directly via search
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
      id: contact.id,
      email: props.email || "",
      firstname: props.firstname || "",
      lastname: props.lastname || "",
      phone: props.phone || "",
      jobTitle: props.jobtitle || "",
    });
  } catch (err) {
    const status = err.response?.status || 500;
    console.error("GET /contacts/status error:", err.response?.data || err.message);
    return res.status(status).json({ error: "server_error" });
  }
});

// GET /refills/history?email=someone@example.com
// Returns an array of refill-related tasks for this contact.
// Each element looks like:
// {
//   id: string,
//   subject: string,      // cleaned (no "(0)" / "(1)" / "(2)")
//   rawSubject: string,   // original HubSpot subject
//   body: string,
//   timestamp: string,    // ISO date string
//   statusCode: number,   // 0 | 1 | 2
//   status: string        // "in_progress" | "completed" | "canceled"
// }
app.get("/refills/history", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    // Find the contact by email
    const searchResp = await hs.post("/crm/v3/objects/contacts/search", {
      filterGroups: [
        {
          filters: [{ propertyName: "email", operator: "EQ", value: email }],
        },
      ],
      properties: ["email", "firstname", "lastname"],
      limit: 1,
    });

    const contact = searchResp.data?.results?.[0] || null;
    if (!contact || !contact.id) {
      return res.status(404).json({ error: "contact_not_found" });
    }

    const contactId = contact.id;

    // Load associated tasks
    const taskIds = await getAssociatedTaskIds(contactId);
    if (!taskIds.length) {
      // IMPORTANT: return an *array* (Swift expects [RefillTask])
      return res.json([]);
    }

    const tasksRaw = await getTasksByIds(taskIds);

    const tasks = tasksRaw
      .map((t) => {
        const id = t.id;
        const props = t.properties || {};
        const subjectRaw = props.hs_task_subject || "";
        const body = props.hs_task_body || "";
        const timestamp = props.hs_timestamp || "";

        const { code, status, cleanSubject } = parseRefillTask(subjectRaw);

        // Only keep tasks that look like refills based on the cleaned subject
        const sLower = cleanSubject.toLowerCase();
        const looksLikeRefill = sLower.includes("refill");
        if (!looksLikeRefill) {
          return null;
        }

        return {
          id,
          subject: cleanSubject,
          rawSubject: subjectRaw,
          body,
          timestamp,
          statusCode: code, // INT: 0 | 1 | 2
          status,           // "in_progress" | "completed" | "canceled"
        };
      })
      .filter(Boolean)
      // newest first
      .sort((a, b) => {
        if (a.timestamp && b.timestamp) {
          return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        }
        return 0;
      });

    // IMPORTANT: return the array, NOT { tasks: [...] }
    return res.json(tasks);
  } catch (err) {
    const status = err.response?.status || 500;
    const details = err.response?.data || err.message;
    console.error("GET /refills/history error:", details);
    return res.status(status).json({ error: "server_error", details });
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
      return res.status(400).json({
        error: "email, serviceLocation, and scheduledAt are required",
      });
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

    // 1) Create the task (no associations here – avoids the "int value" error)
    const taskResp = await hs.post("/crm/v3/objects/tasks", {
      properties: {
        hs_timestamp: scheduledAt, // ISO8601 string is fine
        hs_task_subject: subject,
        hs_task_body: taskBody,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: "HIGH",
        hs_task_type: "TODO",
      },
    });

    const taskId = taskResp.data?.id;
    if (!taskId) {
      return res.status(500).json({ error: "task_creation_failed" });
    }

    // 2) Associate task → contact (v3 association endpoint)
    await hs.put(
      `/crm/v3/objects/tasks/${taskId}/associations/contacts/${contact.id}/task_to_contact`
    );

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
    if (name && customer.name !== name) {
      await stripe.customers.update(customer.id, { name });
    }
    return customer.id;
  }

  const created = await stripe.customers.create({ email, name });
  return created.id;
}

// Publishable key endpoint for the iOS app
app.get("/stripe/publishable-key", (req, res) => {
  if (!STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

// Create a Stripe Billing Portal Session
app.post("/stripe/create-portal-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "stripe_not_configured" });
    }

    const email = (req.body?.email ?? "").toString().trim();
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ error: "contact_not_found" });
    }

    const props = contact.properties || {};
    const fullName = `${props.firstname || ""} ${props.lastname || ""}`.trim() || undefined;

    // Get or create Stripe Customer
    const customerId = await getOrCreateStripeCustomerByEmail(email, fullName);

    // Create the Billing Portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: PORTAL_RETURN_URL,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-portal-session error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ error: "server_error" });
  }
});

// Subscription: $25/month or whatever price you have configured in Stripe
const SUBSCRIPTION_PRICE_ID = process.env.SUBSCRIPTION_PRICE_ID || "";

// One-time refill: $15 or whatever price you configure
const REFILL_PRICE_ID = process.env.REFILL_PRICE_ID || "";

// Create a PaymentIntent for the subscription (initial payment)
app.post("/stripe/init-subscription-payment", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: { message: "stripe_not_configured" } });
    }

    const email = (req.body?.email ?? "").toString().trim();
    if (!email) {
      return res.status(400).json({ error: { message: "email is required" } });
    }

    const name = (req.body?.name ?? "").toString().trim();

    const customerId = await getOrCreateStripeCustomerByEmail(email, name);

    if (!SUBSCRIPTION_PRICE_ID) {
      return res.status(500).json({ error: { message: "missing_SUBSCRIPTION_PRICE_ID" } });
    }

    // Create Checkout Session for subscription
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer: customerId,
      line_items: [
        {
          price: SUBSCRIPTION_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${PORTAL_RETURN_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PORTAL_RETURN_URL}/cancel`,
    });

    return res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("init-subscription-payment error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ error: { message: err?.message || "stripe_error" } });
  }
});

// Create a one-time payment for a refill
app.post("/stripe/init-refill-payment", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: { message: "stripe_not_configured" } });
    }

    const email = (req.body?.email ?? "").toString().trim();
    if (!email) {
      return res.status(400).json({ error: { message: "email is required" } });
    }

    const name = (req.body?.name ?? "").toString().trim();

    const customerId = await getOrCreateStripeCustomerByEmail(email, name);

    if (!REFILL_PRICE_ID) {
      return res.status(500).json({ error: { message: "missing_REFILL_PRICE_ID" } });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer: customerId,
      line_items: [
        {
          price: REFILL_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${PORTAL_RETURN_URL}/refill-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PORTAL_RETURN_URL}/refill-cancel`,
    });

    return res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("init-refill-payment error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ error: { message: err?.message || "stripe_error" } });
  }
});

// SetupIntent flow to save card first (optional)
app.post("/stripe/init-setup", async (req, res) => {
  try {
    if (!stripe) {
      return res
        .status(500)
        .json({ error: { message: "stripe_not_configured" } });
    }

    const email = (req.body?.email ?? "").toString().trim();
    if (!email) {
      return res
        .status(400)
        .json({ error: { message: "email is required" } });
    }

    const name = (req.body?.name ?? "").toString().trim();
    const customerId = await getOrCreateStripeCustomerByEmail(email, name);

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
    });

    return res.json({ clientSecret: setupIntent.client_secret });
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
