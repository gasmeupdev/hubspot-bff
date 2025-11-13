import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe"; // â† added (kept)

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

if (!HUBSPOT_TOKEN) {
  console.error("Missing HUBSPOT_TOKEN");
  process.exit(1);
}

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";

let stripe = null;
if (!STRIPE_SECRET_KEY || !STRIPE_PUBLISHABLE_KEY) {
  console.warn(
    "Stripe keys not fully configured. STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are required for payment endpoints."
  );
} else {
  stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: "2023-10-16",
  });
}

// --- middleware ---
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(",").map(s => s.trim()),
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
    return contactId;
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
    const ids3 = (r3.data?.results || []).map(x => x.id).filter(Boolean);
    if (ids3.length) return ids3;
  } catch (e) {
    // ignore, try v4
  }
  // v4
  const r4 = await hs.get(`/crm/v4/objects/contacts/${contactId}/associations/notes?limit=100`);
  const ids4 = (r4.data?.results || []).map(x => (x.to && x.to.id ? x.to.id : null)).filter(Boolean);
  return ids4;
}

async function getNotesByIds(ids) {
  if (!ids?.length) return [];
  const resp = await hs.post("/crm/v3/objects/notes/batch/read", {
    properties: ["hs_note_body"],
    inputs: ids.map(id => ({ id })),
  });
  const map = {};
  (resp.data?.results || []).forEach(r => {
    if (r.id && r.properties?.hs_note_body != null) {
      map[r.id] = r.properties.hs_note_body;
    }
  });
  return ids
    .map(id => ({
      id,
      body: map[id] || "",
    }))
    .filter(x => x.body && x.body.length > 0);
}

async function deleteNotesByIds(ids) {
  if (!ids?.length) return;

  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) {
    chunks.push(ids.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      await hs.post("/crm/v3/objects/notes/batch/archive", {
        inputs: chunk.map(id => ({ id })),
      });
    } catch (err) {
      console.error("deleteNotesByIds error:", err.response?.data || err.message || err);
    }
  }
}

async function createNoteForContact(contactId, body) {
  const resp = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: body,
    },
    associations: [
      {
        to: { id: String(contactId) },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 202, // Contact to note association
          },
        ],
      },
    ],
  });
  return resp.data;
}

// -------- Vehicles <-> JSON note helpers --------

function vehiclesToJsonNoteBody(vehicles) {
  const payload = {
    vehicles: vehicles || [],
  };
  return JSON.stringify(payload);
}

function parseVehiclesFromNoteBody(body) {
  if (!body || typeof body !== "string") return [];
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return [];
    if (!Array.isArray(parsed.vehicles)) return [];
    return parsed.vehicles;
  } catch (e) {
    return [];
  }
}

// ========== ROUTES ==========

// Simple health check
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "HubSpot BFF is running" });
});

// Create or update a contact in HubSpot
// POST /contacts
// Body: { email, firstName, lastName, phone }
app.post("/contacts", async (req, res) => {
  try {
    const email = (req.body?.email || "").toString().trim();
    const firstName = req.body?.firstName?.toString() ?? "";
    const lastName  = req.body?.lastName?.toString() ?? "";
    const phone     = req.body?.phone?.toString() ?? "";

    if (!email) {
      return res.status(400).json({ success: false, message: "email is required" });
    }

    // 1) Look for existing contact by email
    const searchResp = await hs.post("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", "firstname", "lastname", "phone"],
      limit: 1,
    });
    const existing = searchResp.data?.results?.[0];

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
        contactId,
        created: false,
        updated: true,
      });
    } else {
      const createResp = await hs.post("/crm/v3/objects/contacts", {
        properties: {
          email,
          ...(firstName ? { firstname: firstName } : {}),
          ...(lastName  ? { lastname:  lastName }  : {}),
          ...(phone     ? { phone } : {}),
        },
      });

      return res.status(201).json({
        success: true,
        contactId: createResp.data?.id,
        created: true,
        updated: false,
      });
    }
  } catch (err) {
    const status  = err.response?.status || 500;
    const details = err.response?.data || err.message;
    console.error("POST /contacts error:", details);
    return res.status(status).json({ success: false, message: "server_error", details });
  }
});
// === END new route ===================

// ========== Vehicle routes ==========

// GET /vehicles?email=...
app.get("/vehicles", async (req, res) => {
  try {
    const email = (req.query.email || "").toString().trim();
    if (!email) {
      return res.status(400).json({ vehicles: [], debug: { message: "email is required" } });
    }

    const debug = { email, steps: [] };

    // 1) Find contact by email
    const contact = await getContactByEmail(email);
    debug.steps.push({
      step: "findContactByEmail",
      found: !!contact,
      contactId: contact?.id || null,
      contactProps: contact?.properties || null,
    });

    if (!contact || !contact.id) {
      return res.status(404).json({ vehicles: [], debug });
    }

    const contactId = contact.id;

    // 2) Get associated note IDs
    const noteIds = await getAssociatedNoteIds(contactId);
    debug.steps.push({ step: "getNoteIdsForContact", count: noteIds.length, noteIds });

    if (!noteIds.length) {
      return res.json({ vehicles: [], debug });
    }

    // 3) Read notes and parse JSON vehicles
    const notes = await getNotesByIds(noteIds);
    debug.steps.push({
      step: "parseNotes",
      parsedPreview: notes.map(n => ({ id: n.id, length: n.body.length })).slice(0, 5),
    });

    let allVehicles = [];
    notes.forEach(note => {
      const vs = parseVehiclesFromNoteBody(note.body);
      if (vs.length) {
        allVehicles = allVehicles.concat(vs);
      }
    });

    return res.json({ vehicles: allVehicles, debug });
  } catch (err) {
    console.error("GET /vehicles error:", err.response?.data || err.message);
    return res.status(500).json({
      vehicles: [],
      debug: {
        error: err.response?.data || err.message,
      },
    });
  }
});

// POST /vehicles/sync
// Body: { email, vehicles: [ ... ] }
app.post("/vehicles/sync", async (req, res) => {
  try {
    const email = (req.body?.email || "").toString().trim();
    const vehicles = Array.isArray(req.body?.vehicles) ? req.body.vehicles : [];
    if (!email) {
      return res.status(400).json({ success: false, message: "email is required" });
    }

    // 1) Find contact
    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ success: false, message: "contact_not_found" });
    }
    const contactId = contact.id;

    // 2) Find and delete existing vehicle notes
    const noteIds = await getAssociatedNoteIds(contactId);
    if (noteIds.length) {
      await deleteNotesByIds(noteIds);
    }

    // 3) Create new note(s) with current vehicles JSON
    const body = vehiclesToJsonNoteBody(vehicles);
    await createNoteForContact(contactId, body);

    return res.json({ success: true });
  } catch (err) {
    console.error("POST /vehicles/sync error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "server_error" });
  }
});

// ==================== NEW ROUTE: contact status (jobtitle) ====================
// GET /contacts/status?email=someone@example.com
// Returns: { jobTitle: string|null }
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
// === END new route =============

// ======================== STRIPE (ADDED/UPDATED) =============================

// Helper to get or create a Stripe customer by email, optionally updating name
async function getOrCreateStripeCustomerByEmail(email, name) {
  // Look for existing customer with the same email
  const existing = await stripe.customers.list({ email, limit: 1 });

  if (existing.data.length > 0) {
    const customer = existing.data[0];
    // Update name when provided (no-op if same/empty)
    if (name && name !== customer.name) {
      await stripe.customers.update(customer.id, { name });
    }
    return customer;
  }
  // Create with name + email
  return await stripe.customers.create({
    email,
    name: name || undefined,
    description: "Gas Me Up app user",
  });
}

// Returns publishable key for iOS app
app.get("/stripe/publishable-key", (_req, res) => {
  if (!STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "Missing STRIPE_PUBLISHABLE_KEY" });
  }
  return res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

// One-off charge via PaymentIntent (kept). Now REQUIRES real email; accepts optional name.
app.post("/stripe/init-subscription-payment", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: { message: "Stripe not configured (missing STRIPE_SECRET_KEY)" } });
    }

    const email = (req.body?.email ?? "").toString().trim();
    const name  = (req.body?.name  ?? "").toString().trim();
    if (!email) return res.status(400).json({ error: { message: "email required" } });

    const customer = await getOrCreateStripeCustomerByEmail(email, name);

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2023-10-16" }
    );

    const amountCents = Number.isFinite(req.body?.amountCents) ? req.body.amountCents : 2500; // default $25

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      customer: customer.id,
      automatic_payment_methods: { enabled: true },
      setup_future_usage: "off_session",
      metadata: { hubspot_email: email, app_source: "ios_signup" },
    });

    // Mark HubSpot contact as subscriber (jobtitle = "1") after Stripe payment intent is created
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

// SetupIntent flow to save card first (optional) â€” now REQUIRES real email; accepts name
app.post("/stripe/init-setup", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: { message: "Stripe not configured (missing STRIPE_SECRET_KEY)" } });
    }

    const email = (req.body?.email ?? "").toString().trim();
    const name  = (req.body?.name  ?? "").toString().trim();
    if (!email) return res.status(400).json({ error: { message: "email required" } });

    const customer = await getOrCreateStripeCustomerByEmail(email, name);

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2023-10-16" }
    );

    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ["card"],
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

// ======================== END STRIPE (ADDED/UPDATED) =============================



// JSON 404
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.originalUrl })
);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
