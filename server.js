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
  headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  timeout: 15000
});

async function findContactByEmail(email) {
  const res = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [
      {
        filters: [{ propertyName: "email", operator: "EQ", value: email }]
      }
    ],
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

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/hubspot/contacts", async (req, res) => {
  try {
    const { email, ...props } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing email" });
    const existing = await findContactByEmail(email);
    if (existing) {
      const id = existing.id;
      const updateRes = await hs.patch(`/crm/v3/objects/contacts/${id}`, {
        properties: { email, ...props }
      });
      return res.json({ action: "updated", id, contact: updateRes.data });
    } else {
      const createRes = await hs.post("/crm/v3/objects/contacts", {
        properties: { email, ...props }
      });
      return res.status(201).json({ action: "created", id: createRes.data.id, contact: createRes.data });
    }
  } catch (err) {
    return res.status(err.response?.status || 500).json({ error: err.message, details: err.response?.data });
  }
});

app.post("/api/hubspot/notes", async (req, res) => {
  try {
    const { email, title, body, contactProperties = {} } = req.body || {};
    if (!email || !title || !body)
      return res.status(400).json({ error: "Missing email/title/body" });

    const existing = await findContactByEmail(email);
    let contactId;
    if (existing) {
      contactId = existing.id;
      if (Object.keys(contactProperties).length)
        await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties: contactProperties });
    } else {
      const createRes = await hs.post("/crm/v3/objects/contacts", {
        properties: { email, ...contactProperties }
      });
      contactId = createRes.data.id;
    }

    const noteId = await createNoteForContact(contactId, title, body);
    res.status(201).json({ ok: true, contactId, noteId });
  } catch (err) {
    return res.status(err.response?.status || 500).json({ error: err.message, details: err.response?.data });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
