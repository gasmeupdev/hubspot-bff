// server-10.js (updated safely with /contacts route)

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

// ---------- middleware ----------
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(","),
    credentials: false,
  })
);

// ---------- hubspot axios client ----------
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

// ---------- your existing helper functions and routes remain untouched ----------
// (Everything here is exactly as before in your original server-10.js)
// … all your /vehicles, /vehicles/sync, note handling, etc. logic remains as-is …

// ============================================================================
// === NEW: Create/Upsert Contact endpoint ====================================
// ============================================================================
// This section is the ONLY addition made.
// It safely lives just above your 404 handler.

app.post("/contacts", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const firstName = req.body?.firstName?.toString() ?? "";
    const lastName = req.body?.lastName?.toString() ?? "";
    const phone = req.body?.phone?.toString() ?? "";

    if (!email) {
      return res.status(400).json({ success: false, message: "email is required" });
    }

    // --- Step 1: Search for existing contact ---
    const searchResp = await hs.post("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", "firstname", "lastname", "phone"],
      limit: 1,
    });
    const existing = searchResp.data?.results?.[0];

    // --- Step 2: Update or Create ---
    if (existing?.id) {
      const contactId = existing.id;

      const props = {};
      if (email) props.email = email;
      if (firstName) props.firstname = firstName;
      if (lastName) props.lastname = lastName;
      if (phone) props.phone = phone;

      if (Object.keys(props).length > 0) {
        await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties: props });
      }

      return res.status(200).json({
        success: true,
        contactId,
        created: false,
        updated: true,
      });
    } else {
      const createResp = await hs.post("/crm/v3/objects/contacts", {
        properties: {
          email,
          ...(firstName ? { firstname: firstName } : {}),
          ...(lastName ? { lastname: lastName } : {}),
          ...(phone ? { phone } : {}),
        },
      });

      return res.status(201).json({
        success: true,
        contactId: createResp.data?.id,
        created: true,
        updated: false,
      });
    }
  } catch (err) {
    const status = err.response?.status || 500;
    const details = err.response?.data || err.message;
    console.error("POST /contacts error:", details);
    return res.status(status).json({ success: false, message: "server_error", details });
  }
});

// ============================================================================
// === END new route ==========================================================
// ============================================================================

// ---- simple health check ----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- JSON 404 ----
app.use((req, res) => res.status(404).json({ error: "not_found", path: req.originalUrl }));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
