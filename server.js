
import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

if (!HUBSPOT_TOKEN) {
  console.error("Missing HUBSPOT_TOKEN");
  process.exit(1);
}

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.options("*", cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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

async function getContactByEmail(email) {
  const resp = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    properties: ["email","firstname","lastname"],
    limit: 1,
  });
  return resp.data?.results?.[0] || null;
}

async function getAssociatedNoteIds(contactId) {
  const resp = await hs.get(`/crm/v4/objects/contacts/${contactId}/associations/notes`, { params: { limit: 200 } });
  return (resp.data?.results || []).map((r) => r.toObjectId);
}

async function deleteNotes(ids) {
  if (!ids?.length) return;
  const batch = 80;
  for (let i = 0; i < ids.length; i += batch) {
    const chunk = ids.slice(i, i + batch);
    await hs.post("/crm/v3/objects/notes/batch/archive", { inputs: chunk.map((id) => ({ id })) });
  }
}

async function createNote(body) {
  // HubSpot requires hs_timestamp on notes
  const resp = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: body,
      hs_timestamp: Date.now() // milliseconds since epoch
    }
  });
  return resp.data?.id;
}

async function associateNoteToContact(noteId, contactId) {
  await hs.put(`/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`);
}

// ---- routes ----
app.post(["/api/hubspot/vehicles/sync","/vehicles/sync"], async (req, res) => {
  try {
    const { email, vehicles } = req.body || {};
    if (!email || !Array.isArray(vehicles)) {
      return res.status(400).json({ error: "email and vehicles[] are required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact) return res.status(404).json({ error: "contact_not_found" });

    const noteIds = await getAssociatedNoteIds(contact.id);
    await deleteNotes(noteIds);

    for (const v of vehicles) {
      const payload = JSON.stringify({
        make: v.make || "",
        model: v.model || "",
        year: v.year || "",
        color: v.color || "",
        licensePlate: v.licensePlate || ""
      });
      const noteId = await createNote(payload);
      await associateNoteToContact(noteId, contact.id);
    }

    return res.status(200).json({ ok: true, created: vehicles.length });
  } catch (err) {
    const status = err.response?.status || 500;
    return res.status(500).json({ error: "server_error", status, hubspot: err.response?.data || null, message: err.message });
  }
});

// JSON 404
app.use((req, res) => res.status(404).json({ error: "not_found", path: req.originalUrl }));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
