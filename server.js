
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

// Prefer v3 associations; fall back to v4 if needed
async function getAssociatedNoteIds(contactId) {
  // v3
  try {
    const r3 = await hs.get(`/crm/v3/objects/contacts/${contactId}/associations/notes?limit=100`);
    const ids3 = (r3.data?.results || []).map(x => x.id).filter(Boolean);
    if (ids3.length) return ids3;
  } catch (e) {
    // ignore, try v4
  }
  // v4
  const r4 = await hs.get(`/crm/v4/objects/contacts/${contactId}/associations/notes?limit=100`);
  const ids4 = (r4.data?.results || []).map(x => (x.to && x.to.id ? x.to.id : null)).filter(Boolean);
  return ids4;
}

async function getNotesByIds(ids) {
  if (!ids?.length) return [];
  const resp = await hs.post("/crm/v3/objects/notes/batch/read", {
    properties: ["hs_note_body", "hs_timestamp"],
    inputs: ids.map(id => ({ id })),
  });
  return resp.data?.results || [];
}

// Archive (delete) a batch of notes
async function deleteExistingNotes(contactId) {
  const ids = await getAssociatedNoteIds(contactId);
  if (!ids.length) return 0;
  try {
    await hs.post("/crm/v3/objects/notes/batch/archive", {
      inputs: ids.map(id => ({ id })),
    });
    return ids.length;
  } catch (err) {
    // Fallback: delete one-by-one if batch/archive not available in this portal
    let deleted = 0;
    for (const id of ids) {
      try {
        await hs.delete(`/crm/v3/objects/notes/${id}`);
        deleted++;
      } catch {
        // continue
      }
    }
    return deleted;
  }
}

// ---------- Vehicle extraction ----------
function normalize(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = ["make", "model", "year", "color", "licensePlate", "plate", "name"];
  const score = keys.reduce((acc, k) => acc + (obj[k] ? 1 : 0), 0);
  if (score >= 2) {
    return {
      name: obj.name || `${obj.make || ""} ${obj.model || ""}`.trim(),
      make: obj.make || "",
      model: obj.model || "",
      year: String(obj.year || ""),
      color: obj.color || "",
      licensePlate: obj.licensePlate || obj.plate || "",
      plate: obj.plate || obj.licensePlate || "",
    };
  }
  return null;
}

// returns an array of normalized vehicles (0..n) from a note body
function extractVehiclesFromBody(body) {
  const out = [];
  if (!body || typeof body !== "string") return out;

  const tryParseAny = (txt) => {
    try { return JSON.parse(txt); } catch { return null; }
  };

  // 1) direct parse
  let parsed = tryParseAny(body);

  // 2) if HTML/text-wrapped, slice the outermost {...} or [...] and try again
  if (!parsed) {
    const firstBrace = body.indexOf("{");
    const lastBrace = body.lastIndexOf("}");
    const firstBracket = body.indexOf("[");
    const lastBracket = body.lastIndexOf("]");
    const hasObject = firstBrace >= 0 && lastBrace > firstBrace;
    const hasArray = firstBracket >= 0 && lastBracket > firstBracket;

    if (hasArray && (!hasObject || firstBracket < firstBrace)) {
      parsed = tryParseAny(body.slice(firstBracket, lastBracket + 1));
    }
    if (!parsed && hasObject) {
      parsed = tryParseAny(body.slice(firstBrace, lastBrace + 1));
    }
  }

  // 3) normalize into an array
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const n = normalize(item);
      if (n) out.push(n);
    }
    return out;
  }

  if (parsed && typeof parsed === "object") {
    // wrapper like { vehicles: [...] }
    if (Array.isArray(parsed.vehicles)) {
      for (const item of parsed.vehicles) {
        const n = normalize(item);
        if (n) out.push(n);
      }
      return out;
    }
    // single object vehicle
    const n = normalize(parsed);
    if (n) out.push(n);
  }

  return out;
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
      const arr = extractVehiclesFromBody(body);
      if (arr.length) vehicles.push(...arr);
      if (debug) raw.push({ id: n.id, bodyPreview: body.slice(0, 300) });
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
  const resp = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_body: body,
      hs_timestamp: Date.now(),
    },
  });
  return resp.data?.id;
}

// v3 association to contact
async function associateNoteToContact(noteId, contactId) {
  await hs.put(`/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`);
}

// Create NEW note(s) but first delete existing ones
async function handleSyncVehicles(req, res) {
  try {
    const { email, vehicles } = req.body || {};
    if (!email || !Array.isArray(vehicles)) {
      return res.status(400).json({ error: "email and vehicles[] are required" });
    }

    const contact = await getContactByEmail(email);
    if (!contact) return res.status(404).json({ error: "contact_not_found" });

    // STEP 1: delete current notes for that contact
    const removed = await deleteExistingNotes(contact.id);

    // STEP 2: create new notes
    let created = 0;
    for (const v of vehicles) {
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

    return res.status(200).json({ ok: true, deleted: removed, created });
  } catch (err) {
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
