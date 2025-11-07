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

// ---------- HubSpot helpers ----------
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
  const resp = await hs.post("/crm/v3/objects/notes/batch/read", {
    properties: ["hs_note_body", "hs_timestamp"],
    inputs: ids.map(id => ({ id })),
  });
  return resp.data?.results || [];
}

// Attempt to normalize a vehicle-looking object
function normalize(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = ["make", "model", "year", "color", "licensePlate", "plate", "name"];
  const score = keys.reduce((acc, k) => acc + (obj[k] ? 1 : 0), 0);
  if (score >= 2) {
    return {
      make: obj.make || "",
      model: obj.model || "",
      year: String(obj.year || ""),
      color: obj.color || "",
      licensePlate: obj.licensePlate || obj.plate || "",
      name: obj.name || `${obj.make || ""} ${obj.model || ""}`.trim(),
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

// ---------- Routes ----------
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
    console.error("GET /vehicles error:", err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({ error: "server_error" });
  }
}

async function createNote(body) {
  // Use epoch ms for hs_timestamp to avoid format edge cases
  const resp = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: body,
      hs_timestamp: Date.now(),
    },
  });
  return resp.data?.id;
}

// *** FIXED: use v3 association endpoint with note_to_contact ***
async function associateNoteToContact(noteId, contactId) {
  await hs.put(
    `/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`
  );
}

// Create NEW note(s) only; do NOT delete old ones
async function handleSyncVehicles(req, res) {
  try {
    const { email, vehicles } = req.body || {};
    if (!email || !Array.isArray(vehicles)) {
      return res.status(400).json({ error: "email and vehicles[] are required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact) return res.status(404).json({ error: "contact_not_found" });

    let created = 0;
    for (const v of vehicles) {
      // Persist a clean JSON body (supports either name/plate/color or make/model/year/licensePlate/color)
      const payload = JSON.stringify({
        name: v.name || `${v.make || ""} ${v.model || ""}`.trim(),
        make: v.make || "",
        model: v.model || "",
        year: v.year || "",
        color: v.color || "",
        licensePlate: v.licensePlate || v.plate || "",
      });

      const noteId = await createNote(payload);
      await associateNoteToContact(noteId, contact.id);
      created++;
    }

    return res.status(200).json({ ok: true, created });
  } catch (err) {
    // If HubSpot returns a 4xx/5xx, surface status and log payload for fast debugging
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("POST /vehicles/sync error:", data);
    return res.status(status).json({ error: "server_error", details: data });
  }
}

// ---- route bindings ----
app.get("/api/hubspot/vehicles", handleGetVehicles);
app.post("/api/hubspot/vehicles/sync", handleSyncVehicles);

app.get("/vehicles", handleGetVehicles);
app.post("/vehicles/sync", handleSyncVehicles);

// JSON 404
app.use((req, res) =>
  res.status(404).json({ error: "not_found", path: req.originalUrl })
);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
