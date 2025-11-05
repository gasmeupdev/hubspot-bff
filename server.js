
import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const FORCE_DRY_RUN = String(process.env.DRY_RUN || "") === "1";

if (!HUBSPOT_TOKEN && !FORCE_DRY_RUN) {
  console.error("Missing HUBSPOT_TOKEN (set DRY_RUN=1 to bypass HubSpot for testing).");
  process.exit(1);
}

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.options("*", cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// Request logger
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: HUBSPOT_TOKEN ? {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  } : {},
  timeout: 20000,
});

hs.interceptors.response.use(
  (resp) => {
    console.log(`[HS OK] ${resp.status} ${resp.config.method?.toUpperCase()} ${resp.config.url}`);
    return resp;
  },
  (err) => {
    const status = err.response?.status || 0;
    const url = err.config?.url;
    console.error(`[HS ERR] ${status} ${err.config?.method?.toUpperCase()} ${url}`);
    if (err.response?.data) console.error(JSON.stringify(err.response.data));
    return Promise.reject(err);
  }
);

async function getContactByEmail(email) {
  if (FORCE_DRY_RUN) return { id: "12345", properties: { email } };
  const resp = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    properties: ["email","firstname","lastname"],
    limit: 1,
  });
  return resp.data?.results?.[0] || null;
}

async function getAssociatedNoteIds(contactId) {
  if (FORCE_DRY_RUN) return ["n1","n2"];
  const resp = await hs.get(`/crm/v4/objects/contacts/${contactId}/associations/notes`, { params: { limit: 200 } });
  return (resp.data?.results || []).map((r) => r.toObjectId);
}

async function deleteNotes(ids) {
  if (!ids?.length || FORCE_DRY_RUN) return;
  const batch = 80;
  for (let i = 0; i < ids.length; i += batch) {
    const chunk = ids.slice(i, i + batch);
    await hs.post("/crm/v3/objects/notes/batch/archive", { inputs: chunk.map((id) => ({ id })) });
  }
}

async function createNote(body) {
  if (FORCE_DRY_RUN) return `dry-${Math.random().toString(36).slice(2)}`;
  const resp = await hs.post("/crm/v3/objects/notes", { properties: { hs_note_body: body } });
  return resp.data?.id;
}

async function associateNoteToContact(noteId, contactId) {
  if (FORCE_DRY_RUN) return;
  await hs.put(`/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`);
}

// Health
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

// Echo to validate iOS body
app.post("/echo", (req, res) => res.status(200).json({ ok: true, youSent: req.body }));

// Sync with detailed debug
app.post(["/api/hubspot/vehicles/sync", "/vehicles/sync"], async (req, res) => {
  const debug = String(req.query.debug || "") === "1";
  const trace = [];
  try {
    const { email, vehicles } = req.body || {};
    trace.push({ step: "input", email, vehiclesCount: Array.isArray(vehicles) ? vehicles.length : null });

    if (!email || !Array.isArray(vehicles)) {
      return res.status(400).json({ error: "email and vehicles[] are required", trace });
    }

    const contact = await getContactByEmail(email);
    trace.push({ step: "getContactByEmail", found: !!contact, contactId: contact?.id });
    if (!contact) return res.status(404).json({ error: "contact_not_found", trace });

    const noteIds = await getAssociatedNoteIds(contact.id);
    trace.push({ step: "getAssociatedNoteIds", count: noteIds.length });

    await deleteNotes(noteIds);
    trace.push({ step: "deleteNotes", deleted: noteIds.length });

    let created = 0;
    for (const v of vehicles) {
      const payload = JSON.stringify({
        make: v.make || "",
        model: v.model || "",
        year: v.year || "",
        color: v.color || "",
        licensePlate: v.licensePlate || ""
      });
      const noteId = await createNote(payload);
      trace.push({ step: "createNote", noteId });

      await associateNoteToContact(noteId, contact.id);
      trace.push({ step: "associateNoteToContact", noteId, contactId: contact.id });
      created++;
    }

    return res.status(200).json({ ok: true, created, ...(debug ? { trace } : {}) });
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data;
    trace.push({ step: "error", status, hubspot: data || null, message: err.message });
    return res.status(500).json({ error: "server_error", trace });
  }
});

// JSON 404
app.use((req, res) => res.status(404).json({ error: "not_found", path: req.originalUrl }));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
