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

const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
  timeout: 15000
});

// ---------- Helpers ----------
async function findContactByEmail(email) {
  const res = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    properties: ["email", "firstname", "lastname"]
  });
  return res.data?.results?.[0] || null;
}

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

// Create a standalone Task (no associations)
// hs_task_subject = title, hs_timestamp = due date/time
async function createTask({ subject, dueISO, body, status = "NOT_STARTED", priority = "MEDIUM", ownerId }) {
  const properties = {
    hs_task_subject: subject,
    hs_timestamp: dueISO,
    hs_task_body: body || "",
    hs_task_status: status,
    hs_task_priority: priority
  };
  if (ownerId) properties.hubspot_owner_id = ownerId;

  const r = await hs.post("/crm/v3/objects/tasks", { properties });
  return r.data; // { id, properties ... }
}

// ---------- Routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// Upsert contact by email; if appointment.startISO exists, also create a Task (no association)
app.post("/api/hubspot/contacts", async (req, res) => {
  try {
    const { email, firstname, lastname, phone, firstName, lastName, appointment, ...restProps } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing email" });

    // Normalize name props
    const fName = firstName ?? firstname ?? "";
    const lName = lastName ?? lastname ?? "";

    // Upsert contact
    const existing = await findContactByEmail(email);
    let contactId;
    if (existing) {
      contactId = existing.id;
      const updateRes = await hs.patch(`/crm/v3/objects/contacts/${contactId}`, {
        properties: { email, firstname: fName, lastname: lName, phone: phone || "", ...restProps }
      });
      // proceed; we still may create a task
    } else {
      const createRes = await hs.post("/crm/v3/objects/contacts", {
        properties: { email, firstname: fName, lastname: lName, phone: phone || "", ...restProps }
      });
      contactId = createRes.data.id;
    }

    // Optionally create a Task, unassociated, titled "Name – {date/time}", due at appointment.startISO
    let taskId = null;
    if (appointment?.startISO) {
      const who = `${(fName || "").trim()} ${(lName || "").trim()}`.trim() || email;
      const friendly = new Date(appointment.startISO).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short"
      });
      const subject = `${who} – ${friendly}`;
      const dueISO = appointment.startISO;

      const task = await createTask({
        subject,
        dueISO,
        body: appointment.location ? `Refill at: ${appointment.location}` : "Refill task from iOS app",
        status: "NOT_STARTED",
        priority: "MEDIUM"
      });
      taskId = task?.id || null;
    }

    return res.status(existing ? 200 : 201).json({
      action: existing ? "updated" : "created",
      id: contactId,
      taskId
    });
  } catch (err) {
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
    return res
      .status(err.response?.status || 500)
      .json({ error: err.message, details: err.response?.data });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
