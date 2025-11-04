
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
app.use(express.json({ limit: "1mb" }));

// Always return JSON for errors
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  next();
});

const HS = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

async function getContactByEmail(email) {
  const resp = await HS.post("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    properties: ["email", "firstname", "lastname"],
    limit: 1,
  });
  return resp.data?.results?.[0] || null;
}

async function getAssociatedNoteIds(contactId) {
  const resp = await HS.get(`/crm/v4/objects/contacts/${contactId}/associations/notes`, { params: { limit: 200 } });
  return (resp.data?.results || []).map((r) => r.toObjectId);
}

async function getNotesByIds(ids) {
  if (!ids?.length) return [];
  const resp = await HS.post("/crm/v3/objects/notes/batch/read", {
    properties: ["hs_note_body", "hs_timestamp"],
    inputs: ids.map((id) => ({ id })),
  });
  return resp.data?.results || [];
}

async function deleteNotes(ids) {
  if (!ids?.length) return;
  const batch = 80;
  for (let i = 0; i < ids.length; i += batch) {
    const chunk = ids.slice(i, i + batch);
    await HS.post("/crm/v3/objects/notes/batch/archive", { inputs: chunk.map((id) => ({ id })) });
  }
}

async function createNote(body) {
  const resp = await HS.post("/crm/v3/objects/notes", { properties: { hs_note_body: body } });
  return resp.data?.id;
}

// IMPORTANT: v4 association single-create uses association type in the path and NO body.
async function associateNoteToContact(noteId, contactId) {
  await HS.put(`/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`);
}

app.get("/healthz", (req, res) => res.status(200).send(JSON.stringify({ ok: true })));

app.get("/api/hubspot/vehicles", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    if (!email) return res.status(400).send(JSON.stringify({ error: "email is required" }));

    const contact = await getContactByEmail(email);
    if (!contact) return res.status(200).send(JSON.stringify({ vehicles: [] }));

    const noteIds = await getAssociatedNoteIds(contact.id);
    const notes = await getNotesByIds(noteIds);

    const vehicles = [];
    for (const n of notes) {
      try {
        const obj = JSON.parse(n.properties?.hs_note_body || "");
        if (obj?.type?.toLowerCase() === "vehicle") {
          vehicles.push({
            make: obj.make || "",
            model: obj.model || "",
            year: obj.year || "",
            color: obj.color || "",
            licensePlate: obj.licensePlate || "",
          });
        }
      } catch (_) { /* ignore non-json notes */ }
    }
    return res.status(200).send(JSON.stringify({ vehicles }));
  } catch (err) {
    console.error("GET /vehicles error", err.response?.data || err.message);
    return res.status(err.response?.status || 500).send(JSON.stringify({ error: "server_error" }));
  }
});

app.post("/api/hubspot/vehicles/sync", async (req, res) => {
  try {
    const { email, vehicles } = req.body || {};
    if (!email || !Array.isArray(vehicles)) {
      return res.status(400).send(JSON.stringify({ error: "email and vehicles[] are required" }));
    }
    const contact = await getContactByEmail(email);
    if (!contact) return res.status(404).send(JSON.stringify({ error: "contact_not_found" }));

    const noteIds = await getAssociatedNoteIds(contact.id);
    await deleteNotes(noteIds);

    for (const v of vehicles) {
      const body = JSON.stringify({
        type: "vehicle",
        make: v.make || "",
        model: v.model || "",
        year: v.year || "",
        color: v.color || "",
        licensePlate: v.licensePlate || "",
      });
      const noteId = await createNote(body);
      await associateNoteToContact(noteId, contact.id);
    }

    return res.status(200).send(JSON.stringify({ ok: true, created: vehicles.length }));
  } catch (err) {
    console.error("POST /vehicles/sync error", err.response?.data || err.message);
    return res.status(err.response?.status || 500).send(JSON.stringify({ error: "server_error" }));
  }
});

// Last-resort 404 that always returns JSON (prevents "Not Found" HTML)
app.use((req, res) => {
  return res.status(404).send(JSON.stringify({ error: "not_found", path: req.originalUrl }));
});

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
