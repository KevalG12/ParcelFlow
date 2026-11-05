/* =====================================================
   ParcelFlow – Intelligent Parcel Monitoring (prototype)
   Plain JavaScript, no libraries.

   How it works (easy to explain in a viva):
   1. ONE function, update(), receives new data (from the ESP32
      or from the Demo buttons) and refreshes the dashboard.
   2. In DEMO mode the buttons create the data locally.
   3. In ESP32 mode the ESP32 sends its readings to our server
      (hosted on Render) and this page asks the server for the
      latest reading every few seconds (fetch).

        ESP32 --POST--> server <--GET-- this page
   ===================================================== */

/* ---------- SETTINGS ---------- */
// Leave SERVER empty when the website is hosted on Render (same address as the server).
// If you open index.html from your own computer instead, put your Render address here,
// for example:  "https://parcelflow-abcd.onrender.com"
const SERVER  = "";
const API_URL = SERVER + "/api/status";
const POLL_MS = 3000;                    // ask the server every 3 seconds

/* ---------- DATA ---------- */
let mode = "demo";            // "demo" or "esp32"
let connection = "demo";      // "demo", "checking", "online", "offline"
let state = newState();       // the current delivery session
let sensor = { temp: 29, hum: 58 };
let history = [];             // saved deliveries for the current mode
let pollTimer = null;
let latest = null;                       // newest ESP32 reading (via the server)
let base = { parcels: 0, cleared: 0 };   // ESP32 counts at the moment START was pressed

function newState() {
  return {
    active: false,
    startTime: null,
    total: 0,        // parcels detected
    cleared: 0,      // parcels cleared
    jams: 0,         // jam incidents
    jam: false,      // is a jam active right now?
    message: "WAITING FOR PARCEL"
  };
}

const $ = (id) => document.getElementById(id);

/* ---------- FORMAT HELPERS (no seconds anywhere) ---------- */
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}
function fmtDuration(start, end) {
  const mins = Math.round((end - start) / 60000);
  if (mins < 1) return "Less than 1 minute";
  return mins + (mins === 1 ? " minute" : " minutes");
}

/* ---------- STORAGE (demo and hardware records are kept apart) ---------- */
function storageKey() { return "parcelflow_history_" + mode; }

function loadHistory() {
  try { history = JSON.parse(localStorage.getItem(storageKey())) || []; }
  catch (e) { history = []; }
}
function saveHistory() {
  try { localStorage.setItem(storageKey(), JSON.stringify(history)); }
  catch (e) { /* storage unavailable – ignore */ }
}

/* =====================================================
   CORE: update() – the only place that changes the numbers.
   d = { parcels, cleared, jam, temperature, humidity }
   ===================================================== */
function update(d) {
  if (d.temperature !== undefined) sensor.temp = d.temperature;
  if (d.humidity !== undefined)    sensor.hum  = d.humidity;

  if (state.active) {
    const parcels = d.parcels ?? state.total;
    const cleared = d.cleared ?? state.cleared;
    const jam     = d.jam ?? state.jam;

    if (parcels > state.total)  state.message = "PARCEL DETECTED";
    if (cleared > state.cleared) state.message = "PARCEL CLEARED";

    if (jam && !state.jam) state.jams++;                    // new jam incident
    if (jam) state.message = "JAM DETECTED";
    if (!jam && state.jam) state.message = zoneMessage(parcels - cleared);  // recovered

    state.total = parcels;
    state.cleared = cleared;
    state.jam = jam;
  }
  renderLive();
}

// After a jam recovers: zone is clear if no parcel is left inside
function zoneMessage(inZone) {
  return inZone > 0 ? "PARCEL DETECTED" : "ZONE CLEAR";
}

/* =====================================================
   START / END DELIVERY
   ===================================================== */
async function startDelivery() {
  if (state.active) return;

  if (mode === "esp32") {
    if (!latest || connection !== "online") {
      alert("The ESP32 is not connected. Check that it is powered on and has Wi-Fi.");
      return;
    }
    // The ESP32 keeps counting all the time, so remember its counts now
    // and count only what happens after this point.
    base = { parcels: latest.parcels, cleared: latest.cleared };
  }

  state = newState();
  state.active = true;
  state.startTime = Date.now();
  renderLive();
}

async function endDelivery() {
  if (!state.active) return;

  const record = {
    number: history.length + 1,
    start: state.startTime,
    end: Date.now(),
    total: state.total,
    cleared: state.cleared,
    jams: state.jams,
    status: "COMPLETED"
  };
  history.push(record);
  saveHistory();

  state = newState();
  renderLive();
  renderHistory();
  toast("DELIVERY " + record.number + " saved to Delivery History");
}

/* =====================================================
   DEMO MODE – buttons create fake events
   ===================================================== */
function demoDrift() {   // small temperature / humidity change so it looks alive
  return {
    temperature: 28 + Math.floor(Math.random() * 3),
    humidity: 56 + Math.floor(Math.random() * 5)
  };
}
function demoSend(changes) {
  update({
    parcels: state.total,
    cleared: state.cleared,
    jam: state.jam,
    ...demoDrift(),
    ...changes
  });
}

function demoDetect() {
  if (!state.active) return toast("Start a delivery first.");
  if (state.jam)     return toast("Zone is jammed – recover the jam first.");
  demoSend({ parcels: state.total + 1 });
}
function demoClear() {
  if (!state.active) return toast("Start a delivery first.");
  if (state.jam)     return toast("Zone is jammed – recover the jam first.");
  if (state.total - state.cleared < 1) return toast("No parcel in the zone. Detect one first.");
  demoSend({ cleared: state.cleared + 1 });
}
function demoJam() {
  if (!state.active) return toast("Start a delivery first.");
  if (state.jam)     return toast("A jam is already active.");
  if (state.total - state.cleared < 1) return toast("Detect a parcel first – a jam needs a parcel.");
  demoSend({ jam: true });
}
function demoRecover() {
  if (!state.active) return toast("Start a delivery first.");
  if (!state.jam)    return toast("There is no jam to recover.");
  // when the jam clears, the stuck parcel moves on and counts as cleared
  demoSend({ jam: false, cleared: state.cleared + 1 });
}

/* =====================================================
   ESP32 MODE – ask the server for the ESP32's latest reading

   The server answers GET /api/status with JSON like:
   {"parcels":5,"cleared":4,"jam":false,"temperature":29,
    "humidity":58,"online":true}
   "online" is true while the ESP32 is still sending data.
   ===================================================== */
async function pollEsp32() {
  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    if (mode !== "esp32") return;           // user switched mode while waiting

    if (!data.online) {                     // server is fine, but the ESP32 is silent
      setConnection("offline");
      return;
    }
    latest = data;
    connection = "online";
    update({
      parcels: Math.max(data.parcels - base.parcels, 0),   // count from START
      cleared: Math.max(data.cleared - base.cleared, 0),
      jam: data.jam,
      temperature: data.temperature,
      humidity: data.humidity
    });
  } catch (e) {
    if (mode === "esp32") setConnection("offline");
  }
}
function startPolling() {
  stopPolling();
  pollEsp32();
  pollTimer = setInterval(pollEsp32, POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}
function setConnection(value) {
  connection = value;
  renderLive();
}

/* =====================================================
   SWITCH BETWEEN DEMO AND ESP32 MODE
   ===================================================== */
function setMode(newMode) {
  if (newMode === mode) return;
  if (state.active) {
    alert("Please end the current delivery before switching mode.");
    return;
  }
  mode = newMode;
  state = newState();

  if (mode === "demo") {
    stopPolling();
    connection = "demo";
    sensor = { temp: 29, hum: 58 };
  } else {
    sensor = { temp: null, hum: null };    // wait for real readings
    latest = null;
    base = { parcels: 0, cleared: 0 };
    connection = "checking";
    startPolling();
  }
  loadHistory();
  renderLive();
  renderHistory();
}

/* =====================================================
   SCREEN DRAWING
   ===================================================== */
function renderLive() {
  // mode badge + side buttons
  const badge = $("modeBadge");
  badge.textContent = mode === "demo" ? "DEMO MODE ACTIVE – SIMULATED DATA" : "ESP32 MODE – LIVE HARDWARE DATA";
  badge.className = "mode-badge " + (mode === "demo" ? "demo" : "esp");
  $("modeDemo").classList.toggle("active", mode === "demo");
  $("modeEsp").classList.toggle("active", mode === "esp32");
  $("demoPanel").classList.toggle("hidden", mode !== "demo");

  // session card
  const status = $("sessionStatus");
  status.textContent = state.active ? "DELIVERY ACTIVE" : "NO ACTIVE DELIVERY";
  status.classList.toggle("active", state.active);
  $("sessionInfo").textContent = state.active
    ? "DELIVERY " + (history.length + 1) + " · " + fmtDate(state.startTime) + " · Started " + fmtTime(state.startTime)
    : "Press START DELIVERY to begin.";
  $("startBtn").disabled = state.active;
  $("endBtn").disabled = !state.active;

  // numbers
  $("statTotal").textContent   = state.total;
  $("statCleared").textContent = state.cleared;
  $("statZone").textContent    = Math.max(state.total - state.cleared, 0);
  $("statTemp").textContent    = sensor.temp === null ? "--" : sensor.temp + " °C";
  $("statHum").textContent     = sensor.hum  === null ? "--" : sensor.hum + " %";

  // connection card
  const conn = {
    demo:     ["Demo Mode",    "amber"],
    checking: ["Checking…",    "amber"],
    online:   ["Connected",    "green"],
    offline:  ["Disconnected", "red"]
  }[connection];
  $("statConn").textContent = conn[0];
  $("connIcon").className = "stat-icon " + conn[1];

  // parcel status box
  const box = $("parcelStatus");
  const msg = state.active ? state.message : "WAITING FOR PARCEL";
  box.textContent = msg;
  box.className = "parcel-status " + ({
    "WAITING FOR PARCEL": "s-idle",
    "PARCEL DETECTED":    "s-detected",
    "PARCEL CLEARED":     "s-cleared",
    "ZONE CLEAR":         "s-zone",
    "JAM DETECTED":       "s-jam"
  }[msg]);

  // jam banner
  $("jamBanner").classList.toggle("hidden", !state.jam);

  // demo buttons only make sense during a delivery
  document.querySelectorAll("#demoPanel .btn").forEach((b) => (b.disabled = !state.active));
}

function renderHistory() {
  $("historySource").textContent = mode === "demo" ? "DEMO RECORDS" : "ESP32 RECORDS";
  $("historyEmpty").classList.toggle("hidden", history.length > 0);
  $("historyTable").classList.toggle("hidden", history.length === 0);

  const body = $("historyBody");
  body.innerHTML = "";
  for (let i = history.length - 1; i >= 0; i--) {      // newest first
    const r = history[i];
    const row = document.createElement("tr");
    row.innerHTML =
      "<td><strong>DELIVERY " + r.number + "</strong></td>" +
      "<td>" + fmtDate(r.start) + "</td>" +
      "<td>" + fmtTime(r.start) + "</td>" +
      "<td>" + fmtTime(r.end) + "</td>" +
      "<td>" + fmtDuration(r.start, r.end) + "</td>" +
      "<td>" + r.total + "</td>" +
      "<td>" + r.cleared + "</td>" +
      "<td>" + r.jams + "</td>" +
      '<td><span class="status-pill">' + r.status + "</span></td>";
    row.addEventListener("click", () => openDetails(i));
    body.appendChild(row);
  }
}

function openDetails(i) {
  const r = history[i];
  const rows = [
    ["Date", fmtDate(r.start)],
    ["Start Time", fmtTime(r.start)],
    ["End Time", fmtTime(r.end)],
    ["Duration", fmtDuration(r.start, r.end)],
    ["Total Parcels", r.total],
    ["Successfully Cleared", r.cleared],
    ["Jam Incidents", r.jams],
    ["Status", r.status],
    ["Data Source", mode === "demo" ? "Demo (simulated)" : "ESP32 hardware"]
  ];
  $("detailTitle").textContent = "DELIVERY " + r.number;
  $("detailList").innerHTML = rows
    .map((x) => "<div><span>" + x[0] + "</span><strong>" + x[1] + "</strong></div>")
    .join("");
  $("modal").classList.remove("hidden");
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 3000);
}

/* =====================================================
   BUTTON WIRING + START-UP
   ===================================================== */
$("startBtn").addEventListener("click", startDelivery);
$("endBtn").addEventListener("click", endDelivery);

$("demoDetect").addEventListener("click", demoDetect);
$("demoClear").addEventListener("click", demoClear);
$("demoJam").addEventListener("click", demoJam);
$("demoRecover").addEventListener("click", demoRecover);

$("modeDemo").addEventListener("click", () => setMode("demo"));
$("modeEsp").addEventListener("click", () => setMode("esp32"));

$("closeModal").addEventListener("click", () => $("modal").classList.add("hidden"));
$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) $("modal").classList.add("hidden");
});

// Two pages: show one, hide the other
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const page = btn.dataset.page;
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $("page-live").classList.toggle("hidden", page !== "live");
    $("page-history").classList.toggle("hidden", page !== "history");
    $("pageTitle").textContent = page === "live"
      ? "ParcelFlow – Intelligent Parcel Monitoring"
      : "Delivery History";
  });
});

loadHistory();
renderLive();
renderHistory();
