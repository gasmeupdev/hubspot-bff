
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

async function getNotesByIds(ids) {
  if (!ids?.length) return [];
  const resp = await hs.post("/crm/v3/objects/notes/batch/read", {
    properties: ["hs_note_body","hs_timestamp"],
    inputs: ids.map((id) => ({ id })),
  });
  return resp.data?.results || [];
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
  const resp = await hs.post("/crm/v3/objects/notes", { properties: { hs_note_body: body } });
  return resp.data?.id;
}

async function associateNoteToContact(noteId, contactId) {
  await hs.put(`/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`);
}

// Parsing helpers (relaxed)
function extractVehicleFromBody(body) {
  if (!body || typeof body !== "string") return null;
  try {
    const obj = JSON.parse(body);
    const v = normalize(obj);
    if (v) return v;
  } catch {}
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = body.slice(start, end + 1);
    try {
      const obj = JSON.parse(candidate);
      const v = normalize(obj);
      if (v) return v;
    } catch {}
  }
  return null;
}

function normalize(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = ["make","model","year","color","licensePlate","plate","lic","vehicle","car"];
  const score = keys.reduce((acc,k) => acc + (obj[k] ? 1 : 0), 0);
  if (score >= 2) {
    return {
      make: obj.make || "",
      model: obj.model || "",
      year: String(obj.year || ""),
      color: obj.color || "",
      licensePlate: obj.licensePlate || obj.plate || obj.lic || ""
    };
  }
  return null;
}

// ----- Routes -----

// GET vehicles (canonical)
app.get("/api/hubspot/vehicles", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    const debug = String(req.query.debug || "") === "1";
    if (!email) return res.status(400).json({ error: "email is required" });

    const contact = await getContactByEmail(email);
    if (!contact) return res.status(200).json({ vehicles: [], debug: { reason: "no_contact" } });

    const noteIds = await getAssociatedNoteIds(contact.id);
    const notes = await getNotesByIds(noteIds);

    const vehicles = [];
    const raw = [];

    for (const n of notes) {
      const body = n.properties?.hs_note_body || "";
      const v = extractVehicleFromBody(body);
      if (v) vehicles.push(v);
      if (debug) raw.push({ id: n.id, body });
    }

    const payload = { vehicles };
    if (debug) payload.debug = { contactId: contact.id, noteIds, totalNotes: notes.length, rawBodies: raw };
    return res.status(200).json(payload);
  } catch (err) {
    console.error("GET /api/hubspot/vehicles error:", err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({ error: "server_error" });
  }
});

// POST sync vehicles (canonical)
app.post("/api/hubspot/vehicles/sync", async (req, res) => {
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
    console.error("POST /api/hubspot/vehicles/sync error:", err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({ error: "server_error" });
  }
});

// ----- Back-compat aliases -----
app.get("/vehicles", (req, res) => {
  req.url = "/api/hubspot/vehicles" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  app._router.handle(req, res);
});

app.post("/vehicles/sync", (req, res) => {
  req.url = "/api/hubspot/vehicles/sync";
  app._router.handle(req, res);
});

// JSON 404
app.use((req, res) => res.status(404).json({ error: "not_found", path: req.originalUrl }));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
