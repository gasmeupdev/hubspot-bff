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
  console.error("Missing HUBSPOT_TOKEN env var.");
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

// ✅ FIX HERE: add hs_timestamp to the note
async function createNoteForContact(contactId, title, body) {
  const now = Date.now(); // ms since epoch – what HubSpot wants for datetime
  const noteRes = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: body,
      hs_timestamp: now
    }
  });
  const noteId = noteRes.data.id;

  // associate note -> contact
  await hs.put(
    `/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}`,
    [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId: 280 // note → contact
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

  const taskId = taskRes.data.id;

  // link task -> contact
  await hs.put(
    `/crm/v4/objects/tasks/${taskId}/associations/contacts/${contactId}`,
    [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId: 204 // task → contact
      }
    ]
  );

  return taskId;
}

// ----------------------------------------------------
// routes
// ----------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// main endpoint your iOS app calls
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
      return res.status(400).json({ error: "Missing email" });
    }

    const fName = firstName ?? "";
    const lName = lastName ?? "";

    // 1) upsert contact
    const existing = await findContactByEmail(email);
    let contactId;

    if (existing) {
      contactId = existing.id;
      await hs.patch(`/crm/v3/objects/contacts/${contactId}`, {
        properties: {
          email,
          firstname: fName,
          lastname: lName,
          phone: phone ?? ""
        }
      });
    } else {
      const createRes = await hs.post("/crm/v3/objects/contacts", {
        properties: {
          email,
          firstname: fName,
          lastname: lName,
          phone: phone ?? ""
        }
      });
      contactId = createRes.data.id;
    }

    // 2) car details -> note on contact
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

      const who = (fName || lName || email).trim();
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

// ----------------------------------------------------
// start
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
