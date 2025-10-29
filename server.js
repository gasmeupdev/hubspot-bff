// server.js
// Express BFF for HubSpot (ES modules). Creates/updates a Contact,
// and (optionally) creates a standalone Task from `appointment.startISO`.
// No task associations are created.

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
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json"
  },
  timeout: 15000
});

// ---------- Helpers ----------
async function findContactByEmail(email) {
  const res = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    properties: ["email", "firstname", "lastname", "phone"],
    limit: 1
  });
  return res.data?.results?.[0] || null;
}

// (optional) notes helper kept here if you still use /api/hubspot/notes
async function createNoteForContact(contactId, title, body) {
  const noteRes = await hs.post("/crm/v3/objects/notes", {
    properties: { hs_note_body: body, hs_note_title: title }
  });
  const noteId = noteRes.data.id;
  await hs.put(`/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}`, [
    { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 280 }
  ]);
  return noteId;
}

// ---------- Routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// Upsert contact by email. If `appointment.startISO` is present, also create a standalone Task (no associations)
app.post("/api/hubspot/contacts", async (req, res) => {
  try {
    // DO NOT forward 'appointment' into HubSpot contact properties.
    const { email, firstname, lastname, phone, firstName, lastName, appointment } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing email" });

    // Normalize name fields
    const fName = firstName ?? firstname ?? "";
    const lName = lastName ?? lastname ?? "";

    // Whitelist only safe, primitive contact properties
    const contactProps = {
      email,
      firstname: fName,
      lastname: lName,
      phone: phone || ""
    };

    // Upsert by email
    const existing = await findContactByEmail(email);
    let contactId;
    if (existing) {
      contactId = existing.id;
      await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties: contactProps });
    } else {
      const createRes = await hs.post("/crm/v3/objects/contacts", { properties: contactProps });
      contactId = createRes.data.id;
    }

    // Optionally create a Task from appointment.startISO (no associations)
    let taskId = null;
    if (appointment?.startISO) {
      const who = `${(fName || "").trim()} ${(lName || "").trim()}`.trim() || email;

      // For hs_timestamp, milliseconds since epoch is the safest format
      const dueMs = Number.isFinite(Date.parse(appointment.startISO))
        ? new Date(appointment.startISO).getTime()
        : Date.now();

      // Title like "John Doe – Nov 2, 2025, 5:00 PM"
      const friendly = new Date(dueMs).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short"
      });

      const taskRes = await hs.post("/crm/v3/objects/tasks", {
        properties: {
          hs_task_subject: `${who} – ${friendly}`,
          hs_timestamp: dueMs,
          hs_task_body: appointment.location
            ? `Refill at: ${appointment.location}`
            : "Refill task from iOS app",
          hs_task_status: "NOT_STARTED", // or COMPLETED
          hs_task_priority: "MEDIUM"     // HIGH | MEDIUM | LOW
        }
      });

      taskId = taskRes.data?.id ?? null;
    }

    return res.status(existing ? 200 : 201).json({
      ok: true,
      action: existing ? "updated" : "created",
      contactId,
      taskId
    });
  } catch (err) {
    console.error("contacts route error:", err.response?.data || err.message);
    return res
      .status(err.response?.status || 500)
      .json({ error: err.message, details: err.response?.data });
  }
});

// Optional notes route (unchanged)
app.post("/api/hubspot/notes", async (req, res) => {
  try {
    const { email, title, body, contactProperties = {} } = req.body || {};
    if (!email || !title || !body) return res.status(400).json({ error: "Missing email/title/body" });

    const existing = await findContactByEmail(email);
    let contactId;
    if (existing) {
      contactId = existing.id;
      if (Object.keys(contactProperties).length) {
        await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties: contactProperties });
      }
    } else {
      const createRes = await hs.post("/crm/v3/objects/contacts", {
        properties: { email, ...contactProperties }
      });
      contactId = createRes.data.id;
    }

    const noteId = await createNoteForContact(contactId, title, body);
    res.status(201).json({ ok: true, contactId, noteId });
  } catch (err) {
    console.error("notes route error:", err.response?.data || err.message);
    return res
      .status(err.response?.status || 500)
      .json({ error: err.message, details: err.response?.data });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
