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
  console.error(
    "HUBSPOT_TOKEN is missing. Set it in your environment / .env file."
  );
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

// HubSpot client
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  timeout: 15000
});

// ----------------------------------------------------
// helpers
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
  const now = Date.now(); // ms since epoch – what HubSpot wants
  const fullBody =
    title && title.trim().length > 0 ? `${title}\n\n${body}` : body;

  const noteRes = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: fullBody,
      hs_timestamp: now
    }
  });

  const noteId = noteRes.data?.id;
  if (!noteId) {
    throw new Error("Failed to create note");
  }

  await hs.put(
    `/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}`,
    [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId: 202 // ✅ correct: note → contact
      }
    ]
  );

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
  if (!taskId) {
    throw new Error("Failed to create task");
  }

  await hs.put(
    `/crm/v4/objects/tasks/${taskId}/associations/contacts/${contactId}`,
    [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId: 3 // contact ↔ task
      }
    ]
  );

  return taskId;
}

// ✅ vehicle helpers (pull vehicles from notes)

// get associated note ids for a contact
async function getNoteIdsForContact(contactId) {
  const res = await hs.get(
    `/crm/v4/objects/contacts/${contactId}/associations/notes`
  );
  return res.data?.results?.map((r) => r.to?.id).filter(Boolean) || [];
}

// get a single note (just need body)
async function getNoteById(noteId) {
  const res = await hs.get(
    `/crm/v3/objects/notes/${noteId}?properties=hs_note_body`
  );
  return res.data;
}

// extract JSON from note body like:
// "Car Information Car details from iOS app: { ... }"
// or "Car Information\n\nCar details from iOS app:\n{ ... }"
function extractVehicleJsonFromNoteBody(body) {
  if (!body || typeof body !== "string") return null;

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const jsonStr = body.slice(start, end + 1).trim();

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

// normalize to frontend shape
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
      `${raw.make || "vehicle"}-${raw.model || ""}-${
        Math.random().toString(36).slice(2, 7)
      }`,
    make: raw.make || "",
    model: raw.model || "",
    year: raw.year ? String(raw.year) : "",
    color: raw.color || "",
    plate
  };

  // if we truly got nothing, skip
  if (
    !vehicle.make &&
    !vehicle.model &&
    !vehicle.year &&
    !vehicle.color &&
    !vehicle.plate
  ) {
    return null;
  }

  return vehicle;
}

// ----------------------------------------------------
// routes
// ----------------------------------------------------

app.get("/", (req, res) => {
  return res.json({ ok: true, name: "hubspot-bff", ts: Date.now() });
});

// MAIN ROUTE (original)
app.post("/hubspot/app-intake", async (req, res) => {
  try {
    const {
      email,
      firstName,
      lastName,
      phone,
      carDetails,
      appointment
    } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    // 1) upsert / find contact
    let contact = await findContactByEmail(email);

    // if not found -> create
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
      // update minimal fields if present
      await hs.patch(`/crm/v3/objects/contacts/${contact.id}`, {
        properties: {
          firstname: firstName ?? contact.properties?.firstname ?? "",
          lastname: lastName ?? contact.properties?.lastname ?? "",
          phone: phone ?? contact.properties?.phone ?? ""
        }
      });
    }

    const contactId = contact.id;

    // 2) carDetails -> note on contact
    if (carDetails && typeof carDetails === "object") {
      const pretty = JSON.stringify(carDetails, null, 2);
      const noteBody = `Car details from iOS app:\n${pretty}`;
      await createNoteForContact(contactId, "Car Information", noteBody);
    }

    // 3) appointment -> task on contact
    let taskId = null;
    if (appointment && appointment.startISO) {
      const start = new Date(appointment.startISO);
      const ts = isNaN(start.getTime()) ? Date.now() : start.getTime();

      const who = (firstName || lastName || email).trim();
      const human = start.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short"
      });

      const subject = `${who} – ${human}`;
      const body =
        appointment.location && appointment.location.trim().length > 0
          ? `Refill location:\n${appointment.location}`
          : "Refill appointment from app";

      taskId = await createTaskForContact(contactId, subject, body, ts);
    }

    return res.status(201).json({
      ok: true,
      contactId,
      taskId
    });
  } catch (err) {
    console.error("HubSpot error:", err.response?.data || err.message);
    return res
      .status(err.response?.status || 500)
      .json({ error: err.message, details: err.response?.data });
  }
});

// ✅ NEW: alias route for your iOS app
// your app is calling POST /api/hubspot/contacts
// so we run the exact same logic as /hubspot/app-intake
app.post("/api/hubspot/contacts", async (req, res) => {
  try {
    const {
      email,
      firstName,
      lastName,
      phone,
      carDetails,
      appointment
    } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

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
      const human = start.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short"
      });

      const subject = `${who} – ${human}`;
      const body =
        appointment.location && appointment.location.trim().length > 0
          ? `Refill location:\n${appointment.location}`
          : "Refill appointment from app";

      taskId = await createTaskForContact(contactId, subject, body, ts);
    }

    return res.status(201).json({
      ok: true,
      contactId,
      taskId
    });
  } catch (err) {
    console.error("HubSpot error (alias):", err.response?.data || err.message);
    return res
      .status(err.response?.status || 500)
      .json({ error: err.message, details: err.response?.data });
  }
});

// ----------------------------------------------------
// vehicles -> from hubspot notes
// GET /vehicles?email=someone@example.com
// ----------------------------------------------------
app.get("/vehicles", async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: "email query param is required" });
  }

  try {
    const contact = await findContactByEmail(email);
    if (!contact) {
      return res.json({ vehicles: [] });
    }

    const contactId = contact.id;
    const noteIds = await getNoteIdsForContact(contactId);

    const notes = await Promise.all(
      noteIds.map((id) => getNoteById(id).catch(() => null))
    );

    const vehicles = [];

    for (const note of notes) {
      if (!note?.properties?.hs_note_body) continue;
      const raw = extractVehicleJsonFromNoteBody(note.properties.hs_note_body);
      const vehicle = normalizeVehicle(raw);
      if (vehicle) {
        vehicles.push(vehicle);
      }
    }

    return res.json({ vehicles });
  } catch (err) {
    console.error(
      "HubSpot error (vehicles):",
      err.response?.data || err.message
    );
    return res
      .status(err.response?.status || 500)
      .json({ error: err.message, details: err.response?.data });
  }
});

// ----------------------------------------------------
// start
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
