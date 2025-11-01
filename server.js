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

const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

// find a contact by email
async function findContactByEmail(email) {
  const res = await hs.post("/crm/v3/objects/contacts/search", {
    filterGroups: [
      {
        filters: [{ propertyName: "email", operator: "EQ", value: email }],
      },
    ],
    properties: ["email", "firstname", "lastname", "phone"],
    limit: 1,
  });
  return res.data?.results?.[0] || null;
}

// create a note and link it to a contact
async function createNoteForContact(contactId, title, body) {
  const noteRes = await hs.post("/crm/v3/objects/notes", {
    properties: {
      hs_note_title: title,
      hs_note_body: body,
    },
  });
  const noteId = noteRes.data.id;

  // associate note -> contact
  await hs.put(
    `/crm/v4/objects/notes/${noteId}/associations/contacts/${contactId}`,
    [
      {
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId: 280, // note -> contact
      },
    ]
  );

  return noteId;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// MAIN endpoint your iOS app is calling
app.post("/api/hubspot/contacts", async (req, res) => {
  try {
    const {
      email,
      firstName,
      lastName,
      phone,
      carDetails, // object from iOS
      appointment, // { startISO, endISO, location }
    } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    const fName = firstName ?? "";
    const lName = lastName ?? "";

    // 1) CREATE / UPDATE CONTACT
    const existing = await findContactByEmail(email);
    let contactId;

    if (existing) {
      contactId = existing.id;
      await hs.patch(`/crm/v3/objects/contacts/${contactId}`, {
        properties: {
          email,
          firstname: fName,
          lastname: lName,
          phone: phone ?? "",
        },
      });
    } else {
      const createRes = await hs.post("/crm/v3/objects/contacts", {
        properties: {
          email,
          firstname: fName,
          lastname: lName,
          phone: phone ?? "",
        },
      });
      contactId = createRes.data.id;
    }

    // 2) CAR DETAILS → NOTE on contact (pretty JSON)
    if (carDetails && typeof carDetails === "object") {
      const pretty = JSON.stringify(carDetails, null, 2);
      const body = `Car details from iOS app:\n${pretty}`;
      await createNoteForContact(contactId, "Car Information", body);
    }

    // 3) APPOINTMENT → TASK linked to contact
    let taskId = null;
    if (appointment && appointment.startISO) {
      // Task subject: Name + date/time
      const who = (fName || lName || email).trim();
      const startDate = new Date(appointment.startISO);
      const friendly = startDate.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      });

      const subject = `${who} – ${friendly}`;
      const locationText =
        (appointment.location && appointment.location.trim()) ||
        "Refill appointment from iOS app";

      const dueTs = isNaN(startDate.getTime())
        ? Date.now()
        : startDate.getTime();

      const taskRes = await hs.post("/crm/v3/objects/tasks", {
        properties: {
          hs_task_subject: subject,
          hs_task_body: locationText, // 🟦 location goes here
          hs_timestamp: dueTs,
          hs_task_status: "NOT_STARTED",
          hs_task_priority: "MEDIUM",
        },
      });

      taskId = taskRes.data.id;

      // ✅ ASSOCIATE TASK → CONTACT (type 204 for task→contact) :contentReference[oaicite:1]{index=1}
      await hs.put(
        `/crm/v4/objects/tasks/${taskId}/associations/contacts/${contactId}`,
        [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 204, // task to contact
          },
        ]
      );
    }

    return res.status(201).json({
      ok: true,
      contactId,
      taskId,
    });
  } catch (err) {
    console.error("HubSpot error:", err.response?.data || err.message);
    return res
      .status(err.response?.status || 500)
      .json({ error: err.message, details: err.response?.data });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
