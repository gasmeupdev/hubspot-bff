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
  console.error("Missing HUBSPOT_TOKEN environment variable.");
  process.exit(1);
}

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN,
    credentials: false,
  })
);
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  })
);

// ✅ HubSpot API instance
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  timeout: 15000,
});

// 🔍 Helper: Find contact by email
async function findContactByEmail(email) {
  const res = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [
      {
        filters: [{ propertyName: "email", operator: "EQ", value: email }],
      },
    ],
    properties: ["email", "firstname", "lastname"],
  });
  return res.data?.results?.[0] || null;
}

// 🧾 Helper: Create a note for a contact
async function createNoteForContact(contactId, title, body) {
  const noteRes = await hs.post("/crm/v3/objects/notes", {
    properties: { hs_note_body: body, hs_note_title: title },
  });
  const noteId = noteRes.data.id;

  // Associate note → contact
  await hs.put(`/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}`, [
    { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 280 },
  ]);

  return noteId;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// 🧠 Main route for contact + task creation
app.post("/api/hubspot/contacts", async (req, res) => {
  try {
    const {
      email,
      firstName,
      lastName,
      phone,
      appointment = {},
      carDetails,
    } = req.body || {};

    if (!email) return res.status(400).json({ error: "Missing email" });

    const fName = firstName ?? "";
    const lName = lastName ?? "";

    // ✅ Upsert Contact
    const existing = await findContactByEmail(email);
    let contactId;
    if (existing) {
      contactId = existing.id;
      await hs.patch(`/crm/v3/objects/contacts/${contactId}`, {
        properties: { firstname: fName, lastname: lName, phone, email },
      });
    } else {
      const createRes = await hs.post("/crm/v3/objects/contacts", {
        properties: { firstname: fName, lastname: lName, phone, email },
      });
      contactId = createRes.data.id;
    }

    // ✅ Add car info as note on the contact
    if (carDetails && typeof carDetails === "string") {
      const noteBody = `Car Details:\n<pre>${carDetails}</pre>`;
      await createNoteForContact(contactId, "Car Information", noteBody);
    }

    // ✅ Create a Task using appointment info
    let taskId = null;
    if (appointment?.startISO) {
      const taskTitle = `${fName || lName || email} - ${appointment.startISO}`;
      const taskBody =
        appointment?.location?.trim()?.length > 0
          ? `Refill Location:\n${appointment.location}`
          : "R
