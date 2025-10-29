// server.js
// Express BFF for HubSpot: Contact upsert + Meeting + Association
// Paste this file into your repo (e.g., gasmeupdev/hubspot-bff/server.js)

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// --- (Optional) CORS for web testing; safe to leave on for mobile ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // lock down later if needed
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- HubSpot setup ----------
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) {
  console.warn('[WARN] HUBSPOT_TOKEN not set. Set it in Render → Environment.');
}

const hs = axios.create({
  baseURL: 'https://api.hubspot.com',
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

// ---------- Helpers ----------
async function upsertContact({ firstName, lastName, email, phone }) {
  // Try create → on 409, search+update
  try {
    const r = await hs.post('/crm/v3/objects/contacts', {
      properties: {
        email,
        firstname: firstName || '',
        lastname: lastName || '',
        phone: phone || ''
      }
    });
    return r.data; // { id, properties, ... }
  } catch (err) {
    const s = err.response?.status;
    if (s === 409) {
      // Already exists → search
      const search = await hs.post('/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email', 'firstname', 'lastname', 'phone'],
        limit: 1
      });
      const found = search.data?.results?.[0];
      if (!found) throw new Error('Email conflict but contact not found via search');
      const id = found.id;

      // Update with provided values if present
      await hs.patch(`/crm/v3/objects/contacts/${id}`, {
        properties: {
          firstname: firstName ?? found.properties.firstname,
          lastname: lastName ?? found.properties.lastname,
          phone: phone ?? found.properties.phone
        }
      });

      // Return the contact
      const getRes = await hs.get(`/crm/v3/objects/contacts/${id}`);
      return getRes.data;
    }
    throw err;
  }
}

async function createMeeting({ title, body, location, startISO, endISO }) {
  const r = await hs.post('/crm/v3/objects/meetings', {
    properties: {
      hs_meeting_start_time: startISO, // ISO8601
      hs_meeting_end_time: endISO,
      hs_meeting_title: title || 'Gas Refill Appointment',
      hs_meeting_body: body || 'Scheduled via iOS app',
      hs_meeting_location: location || 'On-site'
      // hs_timestamp will default to start time in newer portals
    }
  });
  return r.data; // { id, ... }
}

async function associateMeetingToContact(meetingId, contactId) {
  // Try default associationTypeId; if it fails, fetch a valid one
  try {
    await hs.put(`/crm/v4/objects/meetings/${meetingId}/associations/contacts/${contactId}`, {
      associationTypeId: 200
    });
  } catch {
    const labels = await hs.get('/crm/v4/associations/meetings/contacts/labels');
    const typeId = labels.data?.results?.[0]?.typeId;
    if (!typeId) throw new Error('No associationTypeId available for meetings↔contacts');
    await hs.put(`/crm/v4/objects/meetings/${meetingId}/associations/contacts/${contactId}`, {
      associationTypeId: typeId
    });
  }
}

// ---------- Route your iOS app calls ----------
app.post('/api/hubspot/contacts', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, appointment } = req.body || {};

    if (!email) {
      return res.status(400).json({ ok: false, error: 'Email required' });
    }

    // 1) Upsert contact
    const contact = await upsertContact({ firstName, lastName, email, phone });

    // 2) If appointment provided, create meeting and associate
    let meeting = null;
    if (appointment?.startISO && appointment?.endISO) {
      meeting = await createMeeting({
        startISO: appointment.startISO,
        endISO: appointment.endISO,
        location: appointment.location || 'On-site',
        title: 'Gas Refill Appointment',
        body: `Scheduled via iOS app for ${email}`
      });
      await associateMeetingToContact(meeting.id, contact.id);
    }

    res.json({ ok: true, contactId: contact.id, meetingId: meeting?.id ?? null });
  } catch (err) {
    const payload = err?.response?.data || err.message || String(err);
    console.error('[ERROR] /api/hubspot/contacts →', payload);
    const status = err?.response?.status || 500;
    res.status(status).json({ ok: false, error: 'HubSpot sync failed', details: payload });
  }
});

// ---------- Start server (Render expects PORT) ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
