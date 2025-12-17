import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import admin from "firebase-admin";


dotenv.config();

// ========================== FIREBASE ADMIN (FCM PUSH) ===============================
function parseServiceAccount(raw) {
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  let s = raw.trim();

  // unwrap accidental quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }

  // IMPORTANT: parse first
  const obj = JSON.parse(s);

  // Then normalize private_key only (convert "\\n" to "\n")
  if (typeof obj.private_key === "string") {
    obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  }

  return obj;
}
 JSON.parse(s);


try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const serviceAccount = parseServiceAccount(raw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("Firebase Admin initialized:", serviceAccount.project_id);
} catch (e) {
  console.error("Firebase Admin init failed:", e.message);
}

// In-memory tokens (OK for testing). Replace with DB later.
const deviceTokensByEmail = new Map(); // emailLower -> Set(tokens)



const app = express();
const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// === Truck live location in-memory store ===
let truckLocation = null;

// Optional: simple secret key so only Phone A can update
// Set this in your environment variables on the server (and in the app) later.
const TRUCK_LOCATION_SECRET = process.env.TRUCK_LOCATION_SECRET || 'dev-truck-secret';


if (!HUBSPOT_TOKEN) {
  console.error("Missing HUBSPOT_TOKEN");
  process.exit(1);
}

app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

// POST /push/register  { email, fcmToken }
// POST /push/register  { email, fcmToken }
app.post("/push/register", (req, res) => {
  const email = (req.body?.email ?? "").toString().trim().toLowerCase();
  const fcmToken = (req.body?.fcmToken ?? "").toString().trim();

  if (!email || !fcmToken) {
    return res.status(400).json({ error: "email and fcmToken required" });
  }

  const set = deviceTokensByEmail.get(email) ?? new Set();
  set.add(fcmToken);
  deviceTokensByEmail.set(email, set);

  console.log("REGISTER PUSH TOKEN", {
    email,
    tokenCount: set.size,
    tokenPreview: fcmToken.slice(0, 18) + "..."
  });

  return res.json({ ok: true, email, tokenCount: set.size });
});


// POST /push/test  { email, title?, body? }
// POST /push/test  { email, title?, body? }
app.post("/push/test", async (req, res) => {
  try {
    // Always report current init state
    const initState = {
      adminAppsLength: admin.apps.length,
      hasEnv: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    };

    if (!admin.apps.length) {
      console.error("push/test blocked: firebase_admin_not_initialized", initState);
      return res.status(500).json({ error: "firebase_admin_not_initialized", initState });
    }

    const email = (req.body?.email ?? "").toString().trim().toLowerCase();
    const title = (req.body?.title ?? "Gas Me Up").toString();
    const body = (req.body?.body ?? "Test push").toString();

    if (!email) return res.status(400).json({ error: "email required" });

    const set = deviceTokensByEmail.get(email);
    if (!set || set.size === 0) return res.status(404).json({ error: "no_tokens_for_email" });

    const tokens = Array.from(set);

    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { type: "test" },
    });

    const errors = resp.responses
      .map((r, i) =>
        r.success
          ? null
          : {
              tokenPreview: (tokens[i] ?? "").slice(0, 18) + "...",
              code: r.error?.code ?? null,
              message: r.error?.message ?? null,
            }
      )
      .filter(Boolean);

    return res.json({
      ok: true,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
      errors,
    });
  } catch (err) {
    console.error("POST /push/test error:", err?.message ?? err);
    return res.status(500).json({ error: "server_error", details: err?.message ?? String(err) });
  }
});






// HubSpot axios instance
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

// Helper: get contact by email
async function getContactByEmail(email) {
  const resp = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [
      {
        filters: [{ propertyName: "email", operator: "EQ", value: email }],
      },
    ],
    properties: ["email", "firstname", "lastname", "phone", "jobtitle"],
    limit: 1,
  });

  const contact = resp.data?.results?.[0] || null;
  if (!contact) return null;
  return {
    id: contact.id,
    properties: contact.properties || {},
  };
}

// -----------------------------------------------------
// VEHICLES (NOTES-BASED STORAGE ON CONTACT)
// -----------------------------------------------------

// Parse vehicles from notes (one JSON per note)
function parseVehiclesFromNotes(notes) {
  const vehicles = [];
  if (!Array.isArray(notes)) return vehicles;

  for (const note of notes) {
    const body = note.properties?.hs_note_body || "";
    if (!body) continue;

    try {
      const obj = JSON.parse(body);
      const vehicle = {
        id: note.id,
        make: (obj.make ?? "").toString(),
        model: (obj.model ?? "").toString(),
        year: (obj.year ?? "").toString(),
        color: (obj.color ?? "").toString(),
        plate: (obj.plate ?? "").toString(),
        name: (obj.name ?? "").toString(),
      };
      vehicles.push(vehicle);
    } catch (err) {
      console.warn("Skipping non-JSON note:", note.id);
    }
  }

  return vehicles;
}



// get stripe pk
app.get('/stripe/publishable-key', (req, res) => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

  if (!publishableKey) {
    return res.status(500).json({ error: 'Publishable key not found' });
  }

  res.json({ publishableKey });
});



// GET /vehicles?email=...
app.get("/vehicles", async (req, res) => {
  try {
    const email = (req.query.email ?? "").toString().trim();
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ error: "contact_not_found" });
    }

    const contactId = contact.id;

    const assocResp = await hs.get(
      `/crm/v3/objects/contacts/${contactId}/associations/notes`
    );

    const noteIds =
  assocResp.data?.results?.map((r) => r.id).filter(Boolean) || [];


    if (noteIds.length === 0) {
      return res.json({ email, contactId, vehicles: [] });
    }

    const batchResp = await hs.post("/crm/v3/objects/notes/batch/read", {
      properties: ["hs_note_body"],
      inputs: noteIds.map((id) => ({ id })),
    });

    const notes = batchResp.data?.results || [];
    const vehicles = parseVehiclesFromNotes(notes);

    const payload = {
      email,
      contactId: contact.id,
      vehicles,
      debug: {
        noteCount: notes.length,
        parsedCount: vehicles.length,
      },
    };

    return res.json(payload);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("GET /vehicles error:", data);
    return res.status(status).json({ error: "server_error", details: data });
  }
}

);

// Create a note; always ensure hs_note_body is a plain JSON string
async function createNote(body) {
  const textBody = typeof body === "string" ? body : JSON.stringify(body);
  const resp = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: textBody,
            hs_timestamp: new Date().toISOString(), // or Date.now() if you prefer epoch ms

      
    },
  });
  return resp.data;
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


// Associate note -> contact
async function associateNoteToContact(noteId, contactId) {
  await hs.put(
    `/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`
  );
}

// Normalize vehicle properties from incoming payload
function normalizeVehicleProps(obj) {
  const result = {};
  const keys = ["name", "make", "model", "year", "color", "plate"];
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
    result.name =
      parts.length > 0 ? parts.join(" ") : "Vehicle " + Date.now().toString();
  }

  return result;
}

// Sync vehicles array to HubSpot notes (one note per vehicle)
app.post("/vehicles/sync", async (req, res) => {
  try {
    const email = (req.body.email ?? "").toString().trim();
    const rawVehicles = Array.isArray(req.body.vehicles)
      ? req.body.vehicles
      : [];

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ error: "contact_not_found" });
    }

    const contactId = contact.id;

    const assocResp = await hs.get(
      `/crm/v3/objects/contacts/${contactId}/associations/notes`
    );
   const existingNoteIds =
  assocResp.data?.results?.map((r) => r.id).filter(Boolean) || [];


    for (const noteId of existingNoteIds) {
      try {
        await hs.delete(`/crm/v3/objects/notes/${noteId}`);
      } catch (err) {
        console.warn(
          "Failed to delete note",
          noteId,
          err.response?.data || err.message
        );
      }
    }

    const created = [];
    for (const v of rawVehicles) {
      const props = normalizeVehicleProps(v);
      const noteBody = {
        name: props.name,
        make: props.make || "",
        model: props.model || "",
        year: props.year || "",
        color: props.color || "",
        plate: props.plate || "",
      };

      const note = await createNote(noteBody);
      await associateNoteToContact(note.id, contactId);

      created.push({
        id: note.id,
        ...noteBody,
      });
    }

    return res.json({
      email,
      contactId,
      vehicles: created,
      debug: {
        requestedCount: rawVehicles.length,
        createdCount: created.length,
        deletedCount: existingNoteIds.length,
      },
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("POST /vehicles/sync error:", data);
    return res.status(status).json({ error: "server_error", details: data });
  }
});


// HubSpot webhook endpoint (configure URL in HubSpot):
// https://hubspot-bff.onrender.com/hubspot/webhook
app.all("/hubspot/webhook", async (req, res) => {
  // Always respond 200 immediately (HubSpot retries on non-2xx)
  res.status(200).json({ ok: true });

  // Log method + URL so you can see if HubSpot is GET’ing you
  console.log("HUBSPOT WEBHOOK HIT:", req.method, req.originalUrl);

  try {
    if (!admin.apps.length) return;

    const events = Array.isArray(req.body) ? req.body : [];
    console.log("HUBSPOT BODY:", JSON.stringify(events, null, 2));
    console.log("HUBSPOT WEBHOOK HIT:", req.method, req.originalUrl);
console.log("HUBSPOT BODY:", JSON.stringify(events, null, 2));


    for (const ev of events) {
      const objectId = ev.objectId;
      const subscriptionType = (ev.subscriptionType ?? "").toString().toLowerCase();

      const isEmailish =
        subscriptionType.includes("email") || subscriptionType.includes("engagement");
      if (!isEmailish || !objectId) continue;

      let contactEmail = null;

      try {
        const assocResp = await hs.get(
          `/crm/v3/objects/emails/${objectId}/associations/contacts`
        );
        const contactIds =
          assocResp.data?.results?.map((r) => r.id).filter(Boolean) ?? [];

        if (contactIds.length) {
          const cResp = await hs.get(`/crm/v3/objects/contacts/${contactIds[0]}`, {
            params: { properties: "email" },
          });
          contactEmail = (cResp.data?.properties?.email ?? "")
            .toString()
            .trim()
            .toLowerCase();
        }
      } catch {
        continue;
      }

      if (!contactEmail) continue;

      const tokenSet = deviceTokensByEmail.get(contactEmail);
      if (!tokenSet || tokenSet.size === 0) continue;

      await admin.messaging().sendEachForMulticast({
        tokens: Array.from(tokenSet),
        notification: {
          title: "Gas Me Up Update",
          body: "New HubSpot message/status update.",
        },
        data: { type: "hubspot_event", objectId: String(objectId) },
      });
    }
  } catch (err) {
    console.error("hubspot webhook error:", err?.response?.data || err?.message || err);
  }
});



// =================== CONTACT CREATION / UPDATE ===================

app.post("/contacts", async (req, res) => {
  try {
    const {
      email,
      firstName = "",
      lastName = "",
      phone = "",
      jobTitle = "",
    } = req.body || {};

    if (!email) {
      return res
        .status(400)
        .json({ success: false, error: "email is required" });
    }

    const existing = await getContactByEmail(email);
    if (existing && existing.id) {
      const updateResp = await hs.patch(
        `/crm/v3/objects/contacts/${existing.id}`,
        {
          properties: {
            email,
            firstname: firstName,
            lastname: lastName,
            phone,
            jobtitle: jobTitle,
          },
        }
      );

      return res.json({
        success: true,
        mode: "updated",
        id: updateResp.data?.id,
      });
    }

    const createResp = await hs.post("/crm/v3/objects/contacts", {
      properties: {
        email,
        firstname: firstName,
        lastname: lastName,
        phone,
        jobtitle: jobTitle,
      },
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

app.get("/contacts/status", async (req, res) => {
  try {
    const email = (req.query.email ?? "").toString().trim();
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
    console.error(
      "GET /contacts/status error:",
      err.response?.data || err.message
    );
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
    const serviceLocation = (req.body?.serviceLocation ?? "")
      .toString()
      .trim();
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

    const taskResp = await hs.post("/crm/v3/objects/tasks", {
      properties: {
        hs_timestamp: scheduledAt,
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

// GET /refills/history?email=...
// Returns refill-related HubSpot tasks for the contact in the shape
// expected by the iOS app: { refills: [ { id, subject, statusCode, statusLabel, timestamp } ] }
app.get("/refills/history", async (req, res) => {
  try {
    const email = (req.query?.email ?? "").toString().trim();
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact || !contact.id) {
      return res.status(404).json({ error: "contact_not_found" });
    }

    const listResp = await hs.get("/crm/v3/objects/tasks", {
      params: {
        limit: 100,
        properties: [
          "hs_task_subject",
          "hs_task_body",
          "hs_timestamp",
          "hs_task_status",
        ].join(","),
        associations: "contacts",
      },
    });

    const contactId = String(contact.id);
    const rawResults = Array.isArray(listResp.data?.results)
      ? listResp.data.results
      : [];

    const refillTasks = rawResults.filter((task) => {
      const props = task.properties || {};
      const subject = (props.hs_task_subject || "").toString().trim();

      // Must be associated with this contact
      const assocContacts =
        task.associations?.contacts?.results ||
        task.associations?.contacts ||
        [];
      const isAssociated = Array.isArray(assocContacts)
        ? assocContacts.some((c) => String(c.id) === contactId)
        : false;

      if (!isAssociated) return false;

      // Consider this a "refill" task if:
      // - Subject starts with (0), (1), (2), OR
      // - It contains the word "refill"
      const lower = subject.toLowerCase();
      const hasPrefix =
        subject.startsWith("(0)") ||
        subject.startsWith("(1)") ||
        subject.startsWith("(2)");
      const containsRefill = lower.includes("refill");

      return hasPrefix || containsRefill;
    });

    const mapped = refillTasks.map((task) => {
      const props = task.properties || {};
      const rawSubject = (props.hs_task_subject || "").toString();

      let subject = rawSubject;
      let statusCode = 0;

      // Parse leading "(0)", "(1)", "(2)" if present
      const match = rawSubject.match(/^\((\d)\)\s*(.*)$/);
      if (match) {
        statusCode = parseInt(match[1], 10) || 0;
        subject = match[2] || "";
      } else {
        // Fallback to HubSpot status
        const hsStatus = (props.hs_task_status || "").toString().toUpperCase();
        if (hsStatus === "COMPLETED") {
          statusCode = 1;
        } else if (hsStatus === "CANCELED" || hsStatus === "DEFERRED") {
          statusCode = 2;
        } else {
          statusCode = 0;
        }
      }

      let statusLabel;
      switch (statusCode) {
        case 1:
          statusLabel = "Completed";
          break;
        case 2:
          statusLabel = "Canceled";
          break;
        case 0:
        default:
          statusLabel = "In progress";
          break;
      }

      return {
        id: task.id,
        subject,
        timestamp: props.hs_timestamp || task.createdAt || null,
        statusCode,
        statusLabel,
        details: (props.hs_task_body || "").toString(),
      };
    });

    // Newest first
    mapped.sort((a, b) => {
      const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
      const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
      return bTime - aTime;
    });

    return res.json({
      email,
      contactId,
      refills: mapped,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const details = err.response?.data || err.message;
    console.error("GET /refills/history error:", details);
    return res.status(status).json({ error: "server_error", details });
  }
});


// GET /truck/location
// Returns { lat, lng, heading, speed, updatedAt } or 404 if unknown
app.get('/truck/location', (req, res) => {
  if (!truckLocation) {
    return res.status(404).json({ error: 'Truck location not available' });
  }

  return res.json(truckLocation);
});


// POST /truck/location
// Body: { lat: number, lng: number, heading?: number, speed?: number }
// Header: x-truck-secret: <TRUCK_LOCATION_SECRET>
app.post('/truck/location', (req, res) => {
  try {
    const secret = req.headers['x-truck-secret'];
    if (!secret || secret !== TRUCK_LOCATION_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { lat, lng, heading, speed } = req.body || {};

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng must be numbers' });
    }

    truckLocation = {
      lat,
      lng,
      heading: typeof heading === 'number' ? heading : null,
      speed: typeof speed === 'number' ? speed : null,
      updatedAt: new Date().toISOString()
    };

    return res.json({ status: 'ok' });
  } catch (err) {
    console.error('Error updating truck location:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

//stripe-refill-payment

app.post("/stripe/init-refill-payment", async (req, res) => {
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

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2023-10-16" }
    );

    const amountCents = Number.isFinite(req.body?.amountCents)
      ? req.body.amountCents
      : 1500; // default $15

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      customer: customer.id,
      automatic_payment_methods: { enabled: true },
      setup_future_usage: "off_session",
      metadata: {
        hubspot_email: email,
        app_source: "ios_refill",
      },
    });

    return res.json({
      email,
      customerId: customer.id,
      ephemeralKeySecret: ephemeralKey.secret,
      paymentIntentClientSecret: paymentIntent.client_secret,
    });
  } catch (err) {
    console.error(
      "init-refill-payment error:",
      err?.response?.data || err?.message || err
    );
    return res
      .status(500)
      .json({ error: { message: err?.message || "stripe_error" } });
  }
});


app.post("/refills/update", async (req, res) => {
  try {
    const { taskId, subject, body, cancel } = req.body || {};

    if (!taskId) {
      return res.status(400).json({ error: "taskId is required" });
    }

    const properties = {};

    if (typeof subject === "string") {
      properties.hs_task_subject = subject;
    }

    if (typeof body === "string") {
      properties.hs_task_body = body;
    }

    // If this is a cancel action, mark the HubSpot task as canceled.
    const isCancel =
      cancel === true ||
      cancel === "true" ||
      cancel === 1 ||
      cancel === "1";

    if (isCancel) {
      // This makes HubSpot’s own status reflect cancellation.
      properties.hs_task_status = "DEFERRED";
    }

    if (Object.keys(properties).length === 0) {
      return res.status(400).json({ error: "no_updatable_fields" });
    }

    const resp = await hs.patch(`/crm/v3/objects/tasks/${taskId}`, {
      properties,
    });

    const props = resp.data?.properties || {};

    const updatedTask = {
      id: resp.data.id,
      subject: (props.hs_task_subject || "").toString(),
      timestamp: props.hs_timestamp || resp.data.createdAt || null,
      status: (props.hs_task_status || "").toString(),
    };

    return res.json({
      success: true,
      task: updatedTask,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const details = err.response?.data || err.message;
    console.error("POST /refills/update error:", details);
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

//hubspot get gas prices

app.get("/gas-prices", async (req, res) => {
  try {
    // Grab up to 50 tickets with subject + description/body
    const searchRequest = {
      filterGroups: [], // you can tighten this later to a specific pipeline if you want
      properties: ["subject", "description", "hs_ticket_body", "content"],
      limit: 50,
    };

    const resp = await hs.post(
      "/crm/v3/objects/tickets/search",
      searchRequest
    );

    const prices = {
      regular: null,
      mid: null,
      premium: null,
    };

    for (const ticket of resp.data.results || []) {
      const props = ticket.properties || {};
      const subject = (props.subject || "").trim().toLowerCase();
      const desc =
        props.description ||
        props.hs_ticket_body ||
        props.content ||
        "";

      if (!desc) continue;

      // Your convention:
      // ticket "name" (subject) indicates grade:
      // r = regular, m = mid, p = premium
      // be generous in matching so it "just works"
      const firstChar = subject.first || subject.prefix?.(1); // ignore in JS, just illustration

      const startsWithR = subject.startsWith("r ");
      const startsWithM = subject.startsWith("m ");
      const startsWithP = subject.startsWith("p ");
      const hasRegular = subject.includes("regular");
      const hasMid = subject.includes("mid");
      const hasPremium = subject.includes("premium");

      if (!prices.regular && (startsWithR || hasRegular || subject === "r")) {
        prices.regular = desc;
      } else if (!prices.mid && (startsWithM || hasMid || subject === "m")) {
        prices.mid = desc;
      } else if (
        !prices.premium &&
        (startsWithP || hasPremium || subject === "p")
      ) {
        prices.premium = desc;
      }
    }

    console.log("Gas prices payload:", prices);
    return res.json(prices);
  } catch (err) {
    const details = err.response?.data || err.message || err;
    console.error("Error loading gas prices:", details);
    return res.status(500).json({ error: "Failed to load gas prices" });
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

// JSON 404
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.originalUrl })
);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
