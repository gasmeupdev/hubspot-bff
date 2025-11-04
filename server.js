// server.js (ESM)

import express from "express";
import axios from "axios";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

if (!HUBSPOT_TOKEN) {
  console.error("❌ HUBSPOT_TOKEN is missing. Set it in your environment / .env file.");
  process.exit(1);
}

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN,
    credentials: false
  })
);
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false
  })
);

// HubSpot HTTP client
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
  timeout: 15000
});

// ----------------------------------------------------
// Helpers: Contacts / Notes / Tasks
// ----------------------------------------------------

async function findContactByEmail(email) {
  const res = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [
      {
        filters: [{ propertyName: "email", operator: "EQ", value: email }]
      }
    ],
    properties: ["email", "firstname", "lastname", "phone"],
    limit: 1
  });
  return res.data?.results?.[0] || null;
}

async function createNoteForContact(contactId, title, body) {
  const now = Date.now(); // ms since epoch

  const noteRes = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: (title && title.trim().length > 0) ? `${title}\n\n${body}` : body,
      hs_timestamp: now
    }
  });

  const noteId = noteRes.data?.id;
  if (!noteId) {
    throw new Error("Failed to create note");
  }

  // Associate note -> contact (HUBSPOT_DEFINED association)
  await hs.put(`/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}`, [
    {
      associationCategory: "HUBSPOT_DEFINED",
      associationTypeId: 202 // note ↔ contact
    }
  ]);

  return noteId;
}

async function createTaskForContact(contactId, subject, body, timestamp) {
  const taskRes = await hs.post("/crm/v3/objects/tasks", {
    properties: {
      hs_task_subject: subject,
      hs_task_body: body,
      hs_timestamp: timestamp,
      hs_task_status: "NOT_STARTED",
      hs_task_priority: "MEDIUM"
    }
  });

  const taskId = taskRes.data?.id;
  if (!taskId) throw new Error("Failed to create task");

  // Associate task -> contact (HUBSPOT_DEFINED association)
  await hs.put(`/crm/v4/objects/tasks/${taskId}/associations/contacts/${contactId}`, [
    {
      associationCategory: "HUBSPOT_DEFINED",
      associationTypeId: 3 // contact ↔ task
    }
  ]);

  return taskId;
}

// ----------------------------------------------------
// Helpers: Vehicles from Notes
// ----------------------------------------------------

// v4: fetch associated note IDs for a contact
async function getNoteIdsForContact(contactId) {
  const res = await hs.get(`/crm/v4/objects/contacts/${contactId}/associations/notes`);
  return res.data?.results?.map((r) => r.to?.id).filter(Boolean) || [];
}

// v3: fetch a single note (body only)
async function getNoteById(noteId) {
  const res = await hs.get(`/crm/v3/objects/notes/${noteId}?properties=hs_note_body`);
  return res.data;
}

// v3: SEARCH notes by association to contact (fallback path)
async function searchNotesForContact(contactId, limit = 100) {
  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "associations.contact",
            operator: "EQ",
            value: String(contactId)
          }
        ]
      }
    ],
    properties: ["hs_note_body"],
    limit
  };

  const res = await hs.post("/crm/v3/objects/notes/search", body);
  return res.data?.results || [];
}

// normalize HTML-ish bodies coming from HubSpot rich text
function stripHtml(str) {
  return (str || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "");
}

// try to pull the first {...} or [...] block out of a string
function findJsonBlock(s) {
  const text = s ?? "";
  const arr = text.match(/(\[[\s\S]*\])/);
  if (arr) return arr[1];
  const obj = text.match(/(\{[\s\S]*\})/);
  if (obj) return obj[1];
  return null;
}

// extract JSON (object/array) from a HubSpot note body
function extractVehicleJsonFromNoteBody(body) {
  if (!body || typeof body !== "string") return null;

  // 1) Try raw
  try {
    return JSON.parse(body);
  } catch (_) {}

  // 2) Strip HTML and try again
  const plain = stripHtml(body).trim();
  try {
    return JSON.parse(plain);
  } catch (_) {}

  // 3) Find the inner JSON block
  const block = findJsonBlock(body) || findJsonBlock(plain);
  if (!block) return null;

  try {
    return JSON.parse(block);
  } catch (_) {
    return null;
  }
}

// bring various key names into a single normalized vehicle record
function normalizeVehicle(raw) {
  if (!raw || typeof raw !== "object") return null;

  const plate =
    raw.licensePlate ||
    raw.plate ||
    raw.license ||
    raw.license_plate ||
    "";

  const vehicle = {
    id:
      plate ||
      `${raw.make || "vehicle"}-${raw.model || ""}-${Math.random().toString(36).slice(2, 7)}`,
    make: raw.make || "",
    model: raw.model || "",
    year: raw.year ? String(raw.year) : "",
    color: raw.color || "",
    plate
  };

  // if nothing meaningful, skip
  if (!vehicle.make && !vehicle.model && !vehicle.year && !vehicle.color && !vehicle.plate) {
    return null;
  }
  return vehicle;
}

// ----------------------------------------------------
// Routes
// ----------------------------------------------------

app.get("/", (req, res) => {
  return res.json({ ok: true, name: "hubspot-bff", ts: Date.now() });
});

// Primary intake route from app
app.post("/hubspot/app-intake", async (req, res) => {
  try {
    const { email, firstName, lastName, phone, carDetails, appointment } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });

    // upsert contact
    let contact = await findContactByEmail(email);
    if (!contact) {
      const createRes = await hs.post("/crm/v3/objects/contacts", {
        properties: {
          email,
          firstname: firstName ?? "",
          lastname: lastName ?? "",
          phone: phone ?? ""
        }
      });
      contact = createRes.data;
    } else {
      await hs.patch(`/crm/v3/objects/contacts/${contact.id}`, {
        properties: {
          firstname: firstName ?? contact.properties?.firstname ?? "",
          lastname: lastName ?? contact.properties?.lastname ?? "",
          phone: phone ?? contact.properties?.phone ?? ""
        }
      });
    }

    const contactId = contact.id;

    // write carDetails as a note
    if (carDetails && typeof carDetails === "object") {
      const pretty = JSON.stringify(carDetails, null, 2);
      const noteBody = `Car details from iOS app:\n${pretty}`;
      await createNoteForContact(contactId, "Car Information", noteBody);
    }

    // create task for appointment
    let taskId = null;
    if (appointment && appointment.startISO) {
      const start = new Date(appointment.startISO);
      const ts = isNaN(start.getTime()) ? Date.now() : start.getTime();

      const who = (firstName || lastName || email).trim();
      const human = start.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

      const subject = `${who} – ${human}`;
      const body =
        appointment.location && appointment.location.trim().length > 0
          ? `Refill location:\n${appointment.location}`
          : "Refill appointment from app";

      taskId = await createTaskForContact(contactId, subject, body, ts);
    }

    return res.status(201).json({ ok: true, contactId, taskId });
  } catch (err) {
    console.error("HubSpot error:", err.response?.data || err.message);
    return res
      .status(err.response?.status || 500)
      .json({ error: err.message, details: err.response?.data });
  }
});

// Alias POST used by iOS app (same as app-intake)
app.post("/api/hubspot/contacts", async (req, res) => {
  try {
    const { email, firstName, lastName, phone, carDetails, appointment } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });

    let contact = await findContactByEmail(email);
    if (!contact) {
      const createRes = await hs.post("/crm/v3/objects/contacts", {
        properties: {
          email,
          firstname: firstName ?? "",
          lastname: lastName ?? "",
          phone: phone ?? ""
        }
      });
      contact = createRes.data;
    } else {
      await hs.patch(`/crm/v3/objects/contacts/${contact.id}`, {
        properties: {
          firstname: firstName ?? contact.properties?.firstname ?? "",
          lastname: lastName ?? contact.properties?.lastname ?? "",
          phone: phone ?? contact.properties?.phone ?? ""
        }
      });
    }

    const contactId = contact.id;

    if (carDetails && typeof carDetails === "object") {
      const pretty = JSON.stringify(carDetails, null, 2);
      const noteBody = `Car details from iOS app:\n${pretty}`;
      await createNoteForContact(contactId, "Car Information", noteBody);
    }

    let taskId = null;
    if (appointment && appointment.startISO) {
      const start = new Date(appointment.startISO);
      const ts = isNaN(start.getTime()) ? Date.now() : start.getTime();

      const who = (firstName || lastName || email).trim();
      const human = start.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

      const subject = `${who} – ${human}`;
      const body =
        appointment.location && appointment.location.trim().length > 0
          ? `Refill location:\n${appointment.location}`
          : "Refill appointment from app";

      taskId = await createTaskForContact(contactId, subject, body, ts);
    }

    return res.status(201).json({ ok: true, contactId, taskId });
  } catch (err) {
    console.error("HubSpot error (alias):", err.response?.data || err.message);
    return res
      .status(err.response?.status || 500)
      .json({ error: err.message, details: err.response?.data });
  }
});

// ----------------------------------------------------
// Vehicles from HubSpot Notes
// GET /vehicles?email=... [&debug=1]
// GET /contacts?email=... [&debug=1]  (alias)
// ----------------------------------------------------

async function fetchVehicleNotesForContact(contactId, debug = false) {
  // Step A: try associations (fast path)
  let associationIds = [];
  try {
    associationIds = await getNoteIdsForContact(contactId);
  } catch (e) {
    if (debug) console.warn("assoc fetch error:", e.response?.data || e.message);
  }

  // Step B: if empty, try search (reliable path)
  let notesViaSearch = [];
  if (associationIds.length === 0) {
    try {
      notesViaSearch = await searchNotesForContact(contactId, 100);
    } catch (e) {
      if (debug) console.warn("search fetch error:", e.response?.data || e.message);
    }
  }

  return { associationIds, notesViaSearch };
}

async function vehiclesHandler(req, res) {
  const email = req.query.email;
  const debug = String(req.query.debug || "") === "1";
  if (!email) {
    return res.status(400).json({ error: "email query param is required" });
  }

  const dbg = { email, steps: [] };

  try {
    const contact = await findContactByEmail(email);
    dbg.steps.push({
      step: "findContactByEmail",
      found: !!contact,
      contactId: contact?.id,
      contactProps: debug ? contact?.properties : undefined
    });

    if (!contact) {
      return res.json(debug ? { vehicles: [], debug: dbg } : { vehicles: [] });
    }

    const contactId = contact.id;

    // Fetch notes (associations first, then search fallback)
    const { associationIds, notesViaSearch } = await fetchVehicleNotesForContact(contactId, debug);
    dbg.steps.push({
      step: "getNoteIdsForContact",
      count: associationIds.length,
      noteIds: debug ? associationIds : undefined
    });

    const vehicles = [];
    const parsedPreview = [];

    if (associationIds.length > 0) {
      // fetch note bodies by ids
      const notes = await Promise.all(associationIds.map((id) => getNoteById(id).catch(() => null)));
      for (const note of notes) {
        const body = note?.properties?.hs_note_body || "";
        if (!body) continue;
        const raw = extractVehicleJsonFromNoteBody(body);
        const vehicle = normalizeVehicle(raw);
        if (debug) {
          parsedPreview.push({
            via: "associations",
            noteId: note?.id,
            bodyPreview: stripHtml(body).slice(0, 200),
            extracted: raw,
            normalized: vehicle
          });
        }
        if (vehicle) vehicles.push(vehicle);
      }
    } else {
      // use search results (already include properties)
      for (const note of notesViaSearch) {
        const body = note?.properties?.hs_note_body || "";
        if (!body) continue;
        const raw = extractVehicleJsonFromNoteBody(body);
        const vehicle = normalizeVehicle(raw);
        if (debug) {
          parsedPreview.push({
            via: "search",
            noteId: note?.id,
            bodyPreview: stripHtml(body).slice(0, 200),
            extracted: raw,
            normalized: vehicle
          });
        }
        if (vehicle) vehicles.push(vehicle);
      }
      dbg.steps.push({
        step: "searchNotesForContact",
        count: notesViaSearch.length,
        sampleIds: debug ? notesViaSearch.slice(0, 10).map((n) => n.id) : undefined
      });
    }

    dbg.steps.push({ step: "parseNotes", parsedPreview });

    return res.json(debug ? { vehicles, debug: dbg } : { vehicles });
  } catch (err) {
    const details = err.response?.data || err.message;
    if (debug) {
      dbg.error = details;
      return res.status(err.response?.status || 500).json({ vehicles: [], debug: dbg });
    }
    return res
      .status(err.response?.status || 500)
      .json({ error: "Failed to fetch vehicles from HubSpot" });
  }
}

app.get("/vehicles", vehiclesHandler);
app.get("/contacts", vehiclesHandler); // alias so your app can GET /contacts?email=...

// ----------------------------------------------------
// Start
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
