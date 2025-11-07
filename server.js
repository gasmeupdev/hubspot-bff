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

// --- middleware ---
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(",").map(s => s.trim()),
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

// tiny req log
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
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
    properties: ["email", "firstname", "lastname"],
    limit: 1,
  });
  return resp.data?.results?.[0] || null;
}

async function getAssociatedNoteIds(contactId) {
  const r = await hs.get(
    `/crm/v4/objects/contacts/${contactId}/associations/notes?limit=100`
  );
  const ids = (r.data?.results || [])
    .map(x => (x.to && x.to.id ? x.to.id : null))
    .filter(Boolean);
  return ids;
}

async function getNotesByIds(ids) {
  if (!ids?.length) return [];
  // batch read
  const resp = await hs.post("/crm/v3/objects/notes/batch/read", {
    properties: ["hs_note_body", "hs_timestamp"],
    inputs: ids.map(id => ({ id })),
  });
  return resp.data?.results || [];
}

function normalize(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = ["make", "model", "year", "color", "licensePlate", "plate", "lic", "vehicle", "car"];
  const score = keys.reduce((acc, k) => acc + (obj[k] ? 1 : 0), 0);
  if (score >= 2) {
    return {
      make: obj.make || "",
      model: obj.model || "",
      year: String(obj.year || ""),
      color: obj.color || "",
      licensePlate: obj.licensePlate || obj.plate || obj.lic || "",
    };
  }
  return null;
}

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

// ---- handlers ----
async function handleGetVehicles(req, res) {
  try {
    const email = String(req.query.email || "").trim();
    const debug = String(req.query.debug || "") === "1";
    if (!email) return res.status(400).json({ error: "email is required" });

    const contact = await getContactByEmail(email);
    if (!contact)
      return res.status(200).json({ vehicles: [], debug: { reason: "no_contact" } });

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
    if (debug)
      payload.debug = {
        contactId: contact.id,
        noteIds,
        totalNotes: notes.length,
        rawBodies: raw,
      };
    return res.status(200).json(payload);
  } catch (err) {
    console.error("GET vehicles error:", err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({ error: "server_error" });
  }
}

async function createNote(body) {
  // HubSpot requires hs_timestamp
  const resp = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: body,
      hs_timestamp: new Date().toISOString(),
    },
  });
  return resp.data?.id;
}

async function associateNoteToContact(noteId, contactId) {
  await hs.put(`/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`, {
    associationCategory: "HUBSPOT_DEFINED",
    associationTypeId: 202, // note_to_contact
  });
}

// --- SAVE: create new notes only (no deletions) ---
async function handleSyncVehicles(req, res) {
  try {
    const { email, vehicles } = req.body || {};
    if (!email || !Array.isArray(vehicles)) {
      return res.status(400).json({ error: "email and vehicles[] are required" });
    }
    const contact = await getContactByEmail(email);
    if (!contact) return res.status(404).json({ error: "contact_not_found" });

    // Create one new Note per vehicle containing { name, plate, color } JSON
    let created = 0;
    for (const v of vehicles) {
      const payload = JSON.stringify({
        name: v.name || "",
        plate: v.plate || "",
        color: v.color || "",
      });
      const noteId = await createNote(payload);
      await associateNoteToContact(noteId, contact.id);
      created++;
    }

    return res.status(200).json({ ok: true, created });
  } catch (err) {
    console.error("POST vehicles/sync error:", err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({ error: "server_error" });
  }
}

// ---- routes (canonical + aliases) ----
app.get("/api/hubspot/vehicles", handleGetVehicles);
app.post("/api/hubspot/vehicles/sync", handleSyncVehicles);

app.get("/vehicles", handleGetVehicles);
app.post("/vehicles/sync", handleSyncVehicles);

// JSON 404
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.originalUrl })
);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
