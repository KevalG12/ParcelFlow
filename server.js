/* =====================================================
   ParcelFlow – tiny web server (runs on Render)

   Two jobs:
   1. Serve the website (the files in the "public" folder).
   2. Act as a mailbox between the ESP32 and the website:
        ESP32  --POST /api/data-->  server  <--GET /api/status--  website
   The latest reading is kept in memory (no database needed).
   ===================================================== */

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

// Allow the page to talk to the server even if opened from another address
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Secret word the ESP32 must send, so strangers cannot post fake data.
// Must match DEVICE_KEY in the ESP32 sketch.
const DEVICE_KEY = process.env.DEVICE_KEY || "parcelflow123";

// Newest reading from the ESP32
let latest = {
  parcels: 0,
  cleared: 0,
  jam: false,
  temperature: null,
  humidity: null,
  lastSeen: 0            // time of the last message from the ESP32
};

// ESP32 -> server
app.post("/api/data", (req, res) => {
  const b = req.body || {};
  if (b.key !== DEVICE_KEY) return res.status(401).json({ error: "wrong key" });

  latest = {
    parcels: Number(b.parcels) || 0,
    cleared: Number(b.cleared) || 0,
    jam: b.jam === true,
    temperature: b.temperature ?? latest.temperature,
    humidity: b.humidity ?? latest.humidity,
    lastSeen: Date.now()
  };
  res.json({ ok: true });
});

// Website -> server
app.get("/api/status", (req, res) => {
  const online = Date.now() - latest.lastSeen < 15000;   // heard from ESP32 in last 15 s
  res.json({ ...latest, online });
});

// The website itself
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("ParcelFlow running on port " + PORT));
