/* =========================================================
   PREFERENCES / API BASE  (stored locally, never sent anywhere
   except this browser's own backend)
   ========================================================= */
const DEFAULT_API_BASE = "http://127.0.0.1:8000";
const DEFAULT_ML_API_BASE = "http://127.0.0.1:8001";
const DEFAULT_INCIDENT_API_BASE = "http://127.0.0.1:8002";
 
function loadPrefs() {
  try {
    const raw = localStorage.getItem("trackline.prefs");
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}
 
let prefs = Object.assign(
  {
    apiBase: DEFAULT_API_BASE,
    mlApiBase: DEFAULT_ML_API_BASE,
    incidentApiBase: DEFAULT_INCIDENT_API_BASE,
    refreshSeconds: 45,
    defaultQuota: "GN",
  },
  loadPrefs()
);
 
function persistPrefs() {
  localStorage.setItem("trackline.prefs", JSON.stringify(prefs));
}
 
function getApiBase() {
  return (prefs.apiBase || DEFAULT_API_BASE).replace(/\/$/, "");
}

function getMlApiBase() {
  return (prefs.mlApiBase || DEFAULT_ML_API_BASE).replace(/\/$/, "");
}

function getIncidentApiBase() {
  return (prefs.incidentApiBase || DEFAULT_INCIDENT_API_BASE).replace(/\/$/, "");
}
 
/* =========================================================
   GLOBAL STATE
   ========================================================= */
let refreshTimer = null;
let firstLoad = true;
let activeTrainNumber = null;
let selectedService = null;      // for the Overview "Selected service schedule" stat
let fareContext = null;          // {from, to, date} prefilled once a train is selected from results
let lastSearchContext = null;    // {from, to, date} of the last All Trains search
let sessionWatchLog = [];        // in-memory list of trains tracked this session
 
const selectedStations = { from: null, to: null }; // chip selections for All Trains search
 
/* =========================================================
   SAVED ROUTES  (localStorage)
   ========================================================= */
function loadSavedRoutes() {
  try {
    const raw = localStorage.getItem("trackline.savedRoutes");
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}
 
let savedRoutes = loadSavedRoutes();
 
function persistSavedRoutes() {
  localStorage.setItem("trackline.savedRoutes", JSON.stringify(savedRoutes));
}
 
/* =========================================================
   NAVIGATION
   ========================================================= */
function initNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => goToPanel(btn.dataset.panel));
  });
}
 
function goToPanel(name) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
}
 
/* =========================================================
   BACKEND CONNECTION STATUS PILL
   ========================================================= */
async function checkConnection() {
  const pill = document.getElementById("connectionPill");
  const label = document.getElementById("connectionLabel");
  if (!pill || !label) return;
 
  pill.className = "status-pill connecting";
  label.textContent = "Connecting to Rail Radar";
 
  try {
    const res = await fetch(`${getApiBase()}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    pill.className = "status-pill online";
    label.textContent = "Connected to Rail Radar";
  } catch (err) {
    pill.className = "status-pill offline";
    label.textContent = "Backend unreachable";
  }
}
 
/* =========================================================
   OVERVIEW — NETWORK STATS (fetched once, cached server-side too)
   ========================================================= */
async function loadNetworkStats() {
  const trainsEl = document.getElementById("statTrainsIndexed");
  const trainsFoot = document.getElementById("statTrainsIndexedFoot");
  const reachEl = document.getElementById("statNetworkReach");
  const reachFoot = document.getElementById("statNetworkReachFoot");
  if (!trainsEl) return;
 
  try {
    const res = await fetch(`${getApiBase()}/meta/network-stats`);
    const data = await res.json();
 
    if (data.success && data.totalTrains) {
      trainsEl.textContent = Number(data.totalTrains).toLocaleString("en-IN");
      trainsFoot.textContent = "Cached network snapshot";
    } else {
      trainsEl.textContent = "—";
      trainsFoot.textContent = "Snapshot unavailable right now";
    }
 
    if (data.success && data.totalStations) {
      reachEl.textContent = Number(data.totalStations).toLocaleString("en-IN");
      reachFoot.textContent = "Stations covered by Rail Radar";
    } else {
      reachEl.textContent = "—";
      reachFoot.textContent = "Station count unavailable right now";
    }
  } catch (err) {
    trainsEl.textContent = "—";
    trainsFoot.textContent = "Could not reach backend";
    reachEl.textContent = "—";
    reachFoot.textContent = "Could not reach backend";
  }
}
 
function updateSelectedServiceStat() {
  const el = document.getElementById("statSelectedService");
  const foot = document.getElementById("statSelectedServiceFoot");
  if (!el) return;
 
  if (!selectedService) {
    el.textContent = "No train selected";
    foot.textContent = "Pick a train in All Trains or Live Tracking";
    return;
  }
 
  el.textContent = `${selectedService.number || "----"}${selectedService.name ? " · " + selectedService.name : ""}`;
  if (selectedService.delay > 0) {
    foot.textContent = `Running ${selectedService.delay} min late`;
  } else if (selectedService.delay < 0) {
    foot.textContent = `${Math.abs(selectedService.delay)} min ahead of schedule`;
  } else {
    foot.textContent = "On time";
  }
}
 
/* =========================================================
   SESSION WATCH LOG
   ========================================================= */
function addToWatchLog(entry) {
  sessionWatchLog = sessionWatchLog.filter((e) => e.number !== entry.number);
  sessionWatchLog.unshift(entry);
  sessionWatchLog = sessionWatchLog.slice(0, 20);
 
  const statEl = document.getElementById("statServiceWatch");
  if (statEl) statEl.textContent = sessionWatchLog.length;
 
  renderWatchLog();
  renderOverviewRecent();
}
 
function delayLabel(delay) {
  if (delay > 0) return `+${delay} min`;
  if (delay < 0) return `${delay} min`;
  return "On time";
}
 
function renderWatchLog() {
  const el = document.getElementById("watchLog");
  if (!el) return;
 
  if (sessionWatchLog.length === 0) {
    el.innerHTML = `<p class="empty-note">No trains tracked yet this session.</p>`;
    return;
  }
 
  el.innerHTML = sessionWatchLog
    .map(
      (e) => `
    <div class="watch-row" data-number="${escapeHtml(e.number)}">
      <div class="watch-row-main">
        <span class="train-num-badge">${escapeHtml(e.number || "----")}</span>
        <span class="recent-row-name">${escapeHtml(e.name || "Unknown train")}</span>
      </div>
      <span class="watch-row-meta">${delayLabel(e.delay)}</span>
    </div>`
    )
    .join("");
 
  el.querySelectorAll(".watch-row").forEach((row) => {
    row.addEventListener("click", () => trackLive(row.dataset.number));
  });
}
 
function renderOverviewRecent() {
  const el = document.getElementById("overviewRecent");
  if (!el) return;
 
  if (sessionWatchLog.length === 0) {
    el.innerHTML = `<p class="empty-note">Nothing tracked yet — head to <strong>All Trains</strong> to search a route, or <strong>Live Tracking</strong> to look up a train number directly.</p>`;
    return;
  }
 
  el.innerHTML = sessionWatchLog
    .slice(0, 5)
    .map(
      (e) => `
    <div class="recent-row" data-number="${escapeHtml(e.number)}">
      <div class="recent-row-main">
        <span class="train-num-badge">${escapeHtml(e.number || "----")}</span>
        <span class="recent-row-name">${escapeHtml(e.name || "Unknown train")}</span>
      </div>
      <span class="recent-row-meta">${delayLabel(e.delay)}</span>
    </div>`
    )
    .join("");
 
  el.querySelectorAll(".recent-row").forEach((row) => {
    row.addEventListener("click", () => trackLive(row.dataset.number));
  });
}
 
/* =========================================================
   SAVED ROUTES — rendering + wiring
   ========================================================= */
function renderSavedRoutes() {
  const el = document.getElementById("savedRoutesList");
  if (el) {
    if (savedRoutes.length === 0) {
      el.innerHTML = `<p class="empty-note">No saved routes yet — add one above.</p>`;
    } else {
      el.innerHTML = savedRoutes
        .map(
          (r, i) => `
        <div class="saved-row" data-index="${i}">
          <div class="recent-row-main">
            <span class="train-num-badge">${escapeHtml(r.from)} → ${escapeHtml(r.to)}</span>
            <span class="recent-row-name">${escapeHtml(r.label || "")}</span>
          </div>
          <button class="saved-row-remove" data-remove="${i}" type="button" aria-label="Remove saved route">✕</button>
        </div>`
        )
        .join("");
    }
 
    el.querySelectorAll(".saved-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".saved-row-remove")) return;
        applySavedRoute(savedRoutes[Number(row.dataset.index)]);
      });
    });
    el.querySelectorAll(".saved-row-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        savedRoutes.splice(Number(btn.dataset.remove), 1);
        persistSavedRoutes();
        renderSavedRoutes();
      });
    });
  }
 
  renderOverviewSaved();
}
 
function renderOverviewSaved() {
  const el = document.getElementById("overviewSaved");
  if (!el) return;
 
  if (savedRoutes.length === 0) {
    el.innerHTML = `<p class="empty-note">No saved routes yet.</p>`;
    return;
  }
 
  el.innerHTML = savedRoutes
    .slice(0, 5)
    .map(
      (r, i) => `
    <div class="recent-row" data-index="${i}">
      <div class="recent-row-main">
        <span class="train-num-badge">${escapeHtml(r.from)} → ${escapeHtml(r.to)}</span>
        <span class="recent-row-name">${escapeHtml(r.label || "")}</span>
      </div>
    </div>`
    )
    .join("");
 
  el.querySelectorAll(".recent-row").forEach((row) => {
    row.addEventListener("click", () => applySavedRoute(savedRoutes[Number(row.dataset.index)]));
  });
}
 
function initSavedRoutesForm() {
  const btn = document.getElementById("saveRouteBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const from = document.getElementById("savedFrom").value.trim().toUpperCase();
    const to = document.getElementById("savedTo").value.trim().toUpperCase();
    const label = document.getElementById("savedLabel").value.trim();
    if (!from || !to) return;
 
    savedRoutes.unshift({ from, to, label });
    persistSavedRoutes();
    renderSavedRoutes();
 
    document.getElementById("savedFrom").value = "";
    document.getElementById("savedTo").value = "";
    document.getElementById("savedLabel").value = "";
  });
}
 
function applySavedRoute(route) {
  if (!route) return;
  goToPanel("all-trains");
  setStationSelection("from", { code: route.from, name: route.from, city: "" });
  setStationSelection("to", { code: route.to, name: route.to, city: "" });
  findTrains();
}
 
/* =========================================================
   ALL TRAINS — PILL STATION FIELDS + TYPE-AHEAD
   ========================================================= */
function setStationSelection(key, station) {
  selectedStations[key] = station;
  const input = document.getElementById(`${key}Station`);
  const chip = document.getElementById(`${key}Chip`);
  if (!input || !chip) return;
  const wrap = input.closest(".pill-input-wrap");
 
  chip.innerHTML = `
    <span class="chip-code">${escapeHtml(station.code)}</span>
    <span class="chip-name">${escapeHtml(station.name || "")}</span>
    <button type="button" class="chip-remove" aria-label="Clear ${key} station">✕</button>
  `;
  chip.classList.remove("hidden");
  if (wrap) wrap.classList.add("has-chip");
  input.value = "";
 
  chip.querySelector(".chip-remove").addEventListener("click", () => clearStationSelection(key));
}
 
function clearStationSelection(key) {
  selectedStations[key] = null;
  const input = document.getElementById(`${key}Station`);
  const chip = document.getElementById(`${key}Chip`);
  if (!input || !chip) return;
  const wrap = input.closest(".pill-input-wrap");
 
  chip.classList.add("hidden");
  chip.innerHTML = "";
  if (wrap) wrap.classList.remove("has-chip");
  input.value = "";
  input.focus();
}
 
function initStationField(key) {
  const input = document.getElementById(`${key}Station`);
  const box = document.getElementById(`${key}Suggestions`);
  if (!input || !box) return;
 
  let debounceTimer = null;
 
  input.addEventListener("input", () => {
    const query = input.value.trim();
    clearTimeout(debounceTimer);
 
    if (query.length < 2) {
      box.classList.remove("show");
      box.innerHTML = "";
      return;
    }
 
    debounceTimer = setTimeout(async () => {
      try {
        const response = await fetch(`${getApiBase()}/stations/search?q=${encodeURIComponent(query)}&limit=8`);
        const result = await response.json();
        if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
          box.classList.remove("show");
          box.innerHTML = "";
          return;
        }
 
        box.innerHTML = "";
        result.data.forEach((station) => {
          const item = document.createElement("div");
          item.className = "suggestion-item";
          item.innerHTML = `<span class="code">${escapeHtml(station.code)}</span>${escapeHtml(station.name)}<span class="city">${escapeHtml(
            station.city || ""
          )}</span>`;
          item.addEventListener("click", () => {
            setStationSelection(key, station);
            box.classList.remove("show");
            box.innerHTML = "";
          });
          box.appendChild(item);
        });
        box.classList.add("show");
      } catch (err) {
        console.error("Station search failed:", err);
      }
    }, 250);
  });
 
  document.addEventListener("click", (event) => {
    if (!box.contains(event.target) && event.target !== input) {
      box.classList.remove("show");
    }
  });
}
 
function initSwapButton() {
  const swapBtn = document.getElementById("swapBtn");
  if (!swapBtn) return;
 
  swapBtn.addEventListener("click", () => {
    const fromSel = selectedStations.from;
    const toSel = selectedStations.to;
 
    if (fromSel || toSel) {
      if (toSel) setStationSelection("from", toSel);
      else clearStationSelection("from");
      if (fromSel) setStationSelection("to", fromSel);
      else clearStationSelection("to");
    } else {
      const fromInput = document.getElementById("fromStation");
      const toInput = document.getElementById("toStation");
      const temp = fromInput.value;
      fromInput.value = toInput.value;
      toInput.value = temp;
    }
  });
}
 
/* =========================================================
   ALL TRAINS — SEARCH + ROUTE BOARD RESULTS
   (one call for the whole list — no per-row fare/class calls)
   ========================================================= */
async function findTrains() {
  const fromSel = selectedStations.from;
  const toSel = selectedStations.to;
  const fromTyped = document.getElementById("fromStation").value.trim().toUpperCase();
  const toTyped = document.getElementById("toStation").value.trim().toUpperCase();
  const from = fromSel ? fromSel.code : fromTyped;
  const to = toSel ? toSel.code : toTyped;
  const date = document.getElementById("travelDate").value;
 
  if (!from || !to) {
    updateFindStatus("Please enter both a source and destination station.", "error");
    return;
  }
  if (from === to) {
    updateFindStatus("Source and destination can't be the same station.", "error");
    return;
  }
 
  updateFindStatus("Searching for trains…");
  hideResults();
 
  try {
    const params = new URLSearchParams({ from_station: from, to_station: to, live: "true" });
    if (date) params.set("date", date);
 
    const response = await fetch(`${getApiBase()}/trains/between?${params.toString()}`);
    const result = await response.json();
 
    if (!result.success) {
      const msg = (result.error && result.error.message) || "Could not fetch trains for this route.";
      throw new Error(msg);
    }
 
    const payload = result.data || {};
    const trains = payload.trains || [];
 
    if (trains.length === 0) {
      updateFindStatus(`No direct trains found between ${from} and ${to}.`, "error");
      return;
    }
 
    updateFindStatus(`Found ${trains.length} train${trains.length === 1 ? "" : "s"} from ${from} to ${to}.`, "ok");
    lastSearchContext = { from, to, date };
    renderResults(payload, trains, { from, to });
  } catch (error) {
    console.error("Find trains error:", error);
    updateFindStatus(error.message || "Something went wrong.", "error");
  }
}
 
function renderResults(payload, trains, fallbackCodes) {
  const section = document.getElementById("resultsSection");
  const title = document.getElementById("routeBoardTitle");
  const summary = document.getElementById("resultsSummary");
  const list = document.getElementById("resultsList");
  if (!section || !summary || !list) return;

  const fromCode = (payload.from && payload.from.code) || fallbackCodes.from;
  const toCode = (payload.to && payload.to.code) || fallbackCodes.to;
  const fromName = (payload.from && payload.from.name) || "";
  const toName = (payload.to && payload.to.name) || "";

  title.textContent = `${fromCode} → ${toCode}`;
  summary.textContent = `${trains.length} direct train${trains.length === 1 ? "" : "s"}${
    fromName ? ` • ${fromName} → ${toName}` : ""
  }`;

  list.innerHTML = "";

  trains.forEach((entry) => {
    const train = entry.train || {};
    const from = entry.from || {};
    const to = entry.to || {};
    const live = entry.live || null;

    const row = document.createElement("div");
    row.className = "result-row";
    row.dataset.trainNumber = train.number || "";

    const metaBits = [];
    if (entry.distance) metaBits.push(`${Number(entry.distance).toFixed(0)} km`);
    if (entry.totalHaltsBetween !== undefined) metaBits.push(`${entry.totalHaltsBetween} halts`);
    if (live) {
      metaBits.push(
        live.delayMinutes > 0
          ? `<span class="delay-late">+${live.delayMinutes} min late</span>`
          : `<span class="delay-ontime">On time</span>`
      );
      if (live.platform) metaBits.push(`Platform ${escapeHtml(String(live.platform))}`);
    }

    row.innerHTML = `
      <span class="train-num-badge">${escapeHtml(train.number || "----")}</span>
      <div class="result-times">
        <span>${from.departure || "--:--"}</span>
        <span class="arrow">→</span>
        <span>${to.arrival || "--:--"}</span>
        ${entry.duration ? `<span class="duration">${formatDuration(entry.duration)}</span>` : ""}
      </div>
      <div class="result-body">
        <span class="result-name">${escapeHtml(train.name || "Unknown train")}${
      train.type ? ` · ${escapeHtml(train.type)}` : ""
    }</span>
        <span class="result-meta-line">${metaBits.join(" · ")}</span>
        <span class="result-meta-line result-prediction-line">
          <span class="result-eta-chip loading" data-role="eta-chip">ETA delay: …</span>
          <span class="result-abnormal-chip hidden" data-role="abnormal-chip"></span>
        </span>
      </div>
      ${renderRunDaysStrip(train.runDays)}
      <span class="result-cta">View schedule →</span>
    `;

    row.addEventListener("click", () => selectTrainFromResults(entry, { fromCode, toCode }));
    list.appendChild(row);
  });

  section.classList.remove("hidden");
  enhanceResultRowsWithPredictions(trains);
}

/* =========================================================
   ALL TRAINS SEARCH — inline ETA + abnormal delay chips
   ---------------------------------------------------------
   Best-effort: uses the search-time known station/arrival info
   (not live position, since these trains aren't being tracked yet),
   so this is a rougher estimate than the ETA card in Live Tracking.
   Any report already filed for a listed train (incidentPredictionsByTrain)
   is shown immediately with no extra API call.
   ========================================================= */
async function enhanceResultRowsWithPredictions(trains) {
  const rows = document.querySelectorAll("#resultsList .result-row");

  rows.forEach((row) => {
    const trainNumInt = parseInt(row.dataset.trainNumber, 10);
    const abnormalChip = row.querySelector('[data-role="abnormal-chip"]');
    if (!abnormalChip) return;
    const incidentPred = !isNaN(trainNumInt) ? incidentPredictionsByTrain[trainNumInt] : null;
    if (incidentPred) {
      abnormalChip.textContent = `Abnormal: +${incidentPred.minDelayMin.toFixed(0)}–${incidentPred.maxDelayMin.toFixed(0)} min`;
      abnormalChip.classList.remove("hidden");
    }
  });

  const fetches = trains.map(async (entry) => {
    const train = entry.train || {};
    const to = entry.to || {};
    const live = entry.live || null;
    const trainNumInt = parseInt(train.number, 10);
    const row = document.querySelector(`#resultsList .result-row[data-train-number="${CSS.escape(String(train.number || ""))}"]`);
    const etaChip = row ? row.querySelector('[data-role="eta-chip"]') : null;
    if (!etaChip) return;

    if (isNaN(trainNumInt) || !to.arrival) {
      etaChip.textContent = "ETA delay: not enough data";
      etaChip.classList.remove("loading");
      return;
    }

    try {
      const response = await fetch(`${getMlApiBase()}/trains/${encodeURIComponent(String(trainNumInt))}/prediction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          train_number: trainNumInt,
          journey_progress: 0,
          current_station_code: (entry.from && entry.from.code) || null,
          scheduled_arrival: to.arrival,
          current_delay_min: (live && Number(live.delayMinutes)) || 0,
        }),
      });
      if (!response.ok) throw new Error(`ML service returned ${response.status}`);
      const prediction = await response.json();
      const impact = Number(prediction.additionalImpactMin) || 0;

      etaChip.textContent = impact > 0 ? `ETA delay: +${impact.toFixed(0)} min` : "ETA delay: on schedule";
      etaChip.classList.remove("loading");
    } catch (err) {
      etaChip.textContent = "ETA delay: unavailable";
      etaChip.classList.remove("loading");
    }
  });

  await Promise.allSettled(fetches);
}
 
function renderRunDaysStrip(runDays) {
  if (!Array.isArray(runDays) || runDays.length === 0 || runDays.length === 7) {
    return `<span class="run-daily-badge">Runs Daily</span>`;
  }
  const active = normalizeRunDays(runDays);
  const labels = ["S", "M", "T", "W", "T", "F", "S"];
  return `<div class="run-days">${labels
    .map((l, i) => `<span class="run-day ${active[i] ? "" : "inactive"}">${l}</span>`)
    .join("")}</div>`;
}
 
function normalizeRunDays(runDays) {
  const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const active = [false, false, false, false, false, false, false];
  runDays.forEach((d) => {
    if (typeof d === "number" && d >= 0 && d <= 6) {
      active[d] = true;
      return;
    }
    const key = String(d).trim().slice(0, 3).toLowerCase();
    if (key in map) active[map[key]] = true;
  });
  return active;
}
 
function hideResults() {
  const section = document.getElementById("resultsSection");
  if (section) section.classList.add("hidden");
}
 
/** Selecting a result row jumps into Live Tracking with the full route +
 * live view, and prefills (but does not auto-fetch) the fare form. */
function selectTrainFromResults(entry, codes) {
  const train = entry.train || {};
  const date = document.getElementById("travelDate").value;
  fareContext = { from: codes.fromCode, to: codes.toCode, date };
 
  document.getElementById("trainNumber").value = train.number || "";
  goToPanel("live");
  trackTrain();
  prefillFareFields();
}
 
function prefillFareFields() {
  if (!fareContext) return;
  const fromEl = document.getElementById("fareFrom");
  const toEl = document.getElementById("fareTo");
  const dateEl = document.getElementById("fareDate");
  if (fromEl) fromEl.value = fareContext.from || "";
  if (toEl) toEl.value = fareContext.to || "";
  if (dateEl && fareContext.date) dateEl.value = fareContext.date;
}
 
/* =========================================================
   LIVE TRACKING — TRACK A SINGLE TRAIN
   ========================================================= */
async function trackTrain() {
  const trainNumberInput = document.getElementById("trainNumber");
  const trainNumber = trainNumberInput ? trainNumberInput.value.trim() : "";
 
  if (!trainNumber) {
    updateStatus("Please enter a train number.", "error");
    return;
  }
 
  activeTrainNumber = trainNumber;
  await loadTrain(trainNumber);
 
  if (refreshTimer) clearInterval(refreshTimer);
  const intervalSeconds = Math.max(15, Number(prefs.refreshSeconds) || 45);
  refreshTimer = setInterval(() => {
    if (activeTrainNumber === trainNumber) {
      loadTrain(trainNumber, true);
    }
  }, intervalSeconds * 1000);
}
 
/** Called from watch-log / recent rows / results list. */
function trackLive(trainNumber) {
  document.getElementById("trainNumber").value = trainNumber;
  goToPanel("live");
  trackTrain();
}
 
async function loadTrain(trainNumber, silent = false) {
  try {
    if (!silent) updateStatus("Fetching live train data…");
 
    // halts_only=true: the Live Tracking / journey timeline view only ever
    // shows scheduled STOPPING stations (Where-Is-My-Train style), never
    // every raw track/coordinate point RailRadar can return.
    const response = await fetch(`${getApiBase()}/trains/${encodeURIComponent(trainNumber)}/live?halts_only=true`);
    const result = await response.json();
 
    if (!result.success) {
      const msg = (result.error && result.error.message) || "Train data unavailable.";
      throw new Error(msg);
    }
 
    renderTrain(result.data);
 
    if (!silent) updateStatus("Live train data loaded.", "ok");
  } catch (error) {
    console.error("Train tracking error:", error);
    updateStatus(error.message || "Unable to load train data.", "error");
  }
}
 
/* =========================================================
   RENDER TRAIN CARD + PROGRESS
   ========================================================= */
function renderTrain(data) {
  const trainCard = document.getElementById("trainCard");
  const routeSection = document.getElementById("routeSection");
 
  if (trainCard) trainCard.classList.remove("hidden");
  if (routeSection) routeSection.classList.remove("hidden");
 
  const train = data.train || {};
  const current = data.currentLocation || {};
  const route = data.route || [];
 
  const trainNumber = train.number || data.trainNumber || activeTrainNumber;
  const trainName = train.name || data.trainName || "Unknown Train";
 
  setElementText("trainName", trainName);
  setElementText("trainNumberDisplay", `Train No: ${trainNumber || "N/A"}`);
 
  const statusText = (data.status || "unknown").toLowerCase();
  const statusEl = document.getElementById("runningStatus");
  if (statusEl) {
    statusEl.textContent = statusText.toUpperCase();
    statusEl.className = statusText;
  }
 
  setElementText(
    "currentStation",
    `${current.stationName || "Unknown"}${current.stationCode ? " (" + current.stationCode + ")" : ""}`
  );
 
  const delay = Number(data.delayMinutes ?? current.delayMinutes ?? 0);
  setElementText("delay", delayLabel(delay));
 
  setElementText("distance", `${Number(current.distanceFromOriginKm || 0).toFixed(1)} km`);
  setElementText("source", current.isActualPosition ? "GPS telemetry" : current.positionSource || "Schedule-based");
 
  // Next halt: prefer RailRadar's own authoritative `nextHalt` field
  // (matched back into the halts route list to pick up its full
  // schedule data), falling back to a sequence-based search that no
  // longer requires the current position to itself be an exact halt
  // (see findNextHaltStation -- fixes "Next stop" / ETA target coming
  // back empty whenever the train's live position is a through-station
  // that isn't in the halts-only route list, e.g. running between two
  // scheduled stops).
  const nextStation = findNextHaltStation(route, current, data.nextHalt);
  const nextStopLabel = nextStation
    ? nextStation.stationName || nextStation.stationCode
    : data.nextHalt
    ? data.nextHalt.stationName || data.nextHalt.stationCode
    : null;

  setElementText(
    "positionText",
    nextStopLabel
      ? `${current.stationName || "Unknown"} → ${nextStopLabel}`
      : current.stationName || "Unknown"
  );

  // The train genuinely hasn't left its originating station yet (still
  // resting there ahead of its own scheduled departure time) -- in that
  // case no ETA/delay prediction should be shown anywhere on this page,
  // since there's nothing abnormal happening yet: it just hasn't reached
  // its scheduled departure slot.
  const trainStarted = hasTrainStarted(data);
 
  const totalDistance = Number(train.distance || 0);
  const currentDistance = Number(current.distanceFromOriginKm || 0);
  const journeyPercentage =
    totalDistance > 0 ? Math.min(100, Math.max(0, (currentDistance / totalDistance) * 100)) : 0;
 
  setElementText("progressText", `${journeyPercentage.toFixed(1)}%`);
  const progressFill = document.getElementById("progressFill");
  if (progressFill) progressFill.style.width = `${journeyPercentage}%`;
  const trainMarker = document.getElementById("trainMarker");
  if (trainMarker) trainMarker.style.left = `${journeyPercentage}%`;
 
  setElementText("updatedAt", `Updated: ${formatDateTime(data.lastUpdatedAt)}`);
  setElementText("routeSummary", `${route.length} route point${route.length === 1 ? "" : "s"} • ${getHaltCount(route)} scheduled stops`);
 
  // RailRadar's live telemetry field is `speedKmh` (see currentLocation in
  // the API docs) -- the old `speedKmph` / `speed` keys it was checking
  // don't exist in the actual response, which is why this always showed
  // "—". Kept as fallbacks in case a future API revision renames it.
  const speedValue = current.speedKmh ?? current.speedKmph ?? current.speed ?? data.speedKmh ?? data.speedKmph ?? null;
  setElementText("statSpeed", speedValue !== null && speedValue !== undefined ? `${Number(speedValue).toFixed(0)} km/h` : "—");
  setElementText("statNextStop", nextStopLabel || "—");
  setElementText("statLastUpdated", formatDateTime(data.lastUpdatedAt));
 
  renderRouteTable(route, current);
  applyDelayToRouteTable(trainStarted ? delay : 0, trainStarted);
  renderJourneyTimeline(route, current, trainStarted ? delay : 0);
  fetchAndRenderEtaPrediction(trainNumber, route, current, train, delay, nextStation, trainStarted);
 
  selectedService = { number: trainNumber, name: trainName, status: statusText, delay };
  updateSelectedServiceStat();
  addToWatchLog(selectedService);
 
  if (firstLoad) firstLoad = false;
}
 
/* =========================================================
   VERTICAL JOURNEY TIMELINE (Where-Is-My-Train style)
   Shows ONLY scheduled stopping stations (route is already fetched
   with halts_only=true), in correct order: passed / current / next /
   upcoming — with a train indicator that animates smoothly to its new
   position via CSS transition, rather than jumping. This view is purely
   presentational and never feeds back into ETA/ML/live-location logic.
   ========================================================= */
function renderJourneyTimeline(route, current, delay) {
  const stopsEl = document.getElementById("journeyStops");
  const indicator = document.getElementById("journeyTrainIndicator");
  const scrollEl = document.getElementById("journeyScroll");
  if (!stopsEl) return;
 
  const halts = (Array.isArray(route) ? route : []).filter((s) => s.isHalt === true);
  const list = (halts.length ? halts : route || []).slice().sort((a, b) => Number(a.sequence) - Number(b.sequence));
 
  if (list.length === 0) {
    stopsEl.innerHTML = `<p class="empty-note">No scheduled stopping stations returned for this train.</p>`;
    if (indicator) indicator.style.top = "6px";
    journeyStopsMeta = [];
    return;
  }
 
  const currentSequence = Number(current.sequence);
  let currentIndex = list.findIndex((s) => Number(s.sequence) === currentSequence);
  if (currentIndex === -1 && !isNaN(currentSequence)) {
    // Fall back to the last halt at/before the current sequence.
    for (let i = 0; i < list.length; i++) {
      if (Number(list[i].sequence) <= currentSequence) currentIndex = i;
    }
  }
 
  journeyStopsMeta = [];

  stopsEl.innerHTML = list
    .map((station, i) => {
      let state = "upcoming";
      if (currentIndex !== -1) {
        if (i < currentIndex) state = "passed";
        else if (i === currentIndex) state = "current";
        else if (i === currentIndex + 1) state = "next";
      }
 
      const badge =
        state === "current"
          ? '<span class="journey-stop-badge">Live</span>'
          : state === "next"
          ? '<span class="journey-stop-badge">Next stop</span>'
          : "";
 
      const arr = formatTime(station.scheduledArrival);
      const dep = formatTime(station.scheduledDeparture);

      journeyStopsMeta.push({ index: i, state, schedArr: arr, schedDep: dep });
 
      return `
      <div class="journey-stop ${state}" data-index="${i}">
        <div class="journey-stop-main">
          <span class="journey-stop-name">${escapeHtml(station.stationName || "—")}${badge}</span>
          <span class="journey-stop-code">${escapeHtml(station.stationCode || "")}</span>
        </div>
        <div class="journey-stop-times">
          <span class="journey-time-block">${arr}<small>Arr.</small><span class="journey-time-delay hidden" id="journeyArrDelay-${i}"></span></span>
          <span class="journey-time-block">${dep}<small>Dep.</small><span class="journey-time-delay hidden" id="journeyDepDelay-${i}"></span></span>
        </div>
      </div>`;
    })
    .join("");

  // Immediately project the current LIVE delay (already known from
  // RailRadar) onto every stop the train hasn't reached yet. This gets
  // refined a moment later with the ML-predicted impact figure once
  // fetchAndRenderEtaPrediction resolves (see applyDelayToJourneyTimeline).
  applyDelayToJourneyTimeline(delay);
 
  // Position the train indicator at the current stop (or interpolated
  // toward the next one), then let the CSS `transition: top` on the
  // indicator animate it smoothly from wherever it was last rendered --
  // no instant jump on live-location updates.
  //
  // Accuracy fix: earlier versions anchored to a hardcoded "+16px" offset
  // from the top of each row, which drifted out of alignment whenever a
  // row wrapped onto two lines (long station names) since rows are no
  // longer a fixed height. We now anchor to each row's actual vertical
  // MIDPOINT (offsetTop + offsetHeight / 2), computed after layout, so
  // the dot lines up with the station marker regardless of row height.
  //
  // Accuracy fix 2: interpolation between stops previously required
  // `distanceFromOriginKm` on both the live position AND the station
  // list, which isn't always present. We now fall back to interpolating
  // by SCHEDULED TIME (how far "now" is between the anchor stop's
  // departure and the next stop's arrival) when distance data is
  // missing, so the indicator still creeps forward between stations
  // instead of sitting frozen at the last halt.
  requestAnimationFrame(() => {
    if (!indicator) return;
    const rows = stopsEl.querySelectorAll(".journey-stop");
    if (rows.length === 0) return;
 
    const anchorIndex = currentIndex === -1 ? 0 : currentIndex;
    const anchorRow = rows[anchorIndex];
    const nextRow = rows[anchorIndex + 1];
 
    const rowMid = (row) => row.offsetTop + row.offsetHeight / 2;
    let topPx = rowMid(anchorRow);
 
    if (nextRow) {
      const curDist = Number(current.distanceFromOriginKm);
      const anchorDist = getStationDistanceKm(list[anchorIndex]);
      const nextDist = getStationDistanceKm(list[anchorIndex + 1]);

      let fraction = null;

      if (!isNaN(curDist) && anchorDist !== null && nextDist !== null && nextDist > anchorDist) {
        fraction = (curDist - anchorDist) / (nextDist - anchorDist);
      } else {
        // Distance data unavailable -- fall back to a time-based estimate
        // using each stop's scheduled departure/arrival vs the clock now.
        const anchorTime = parseScheduledTimeToday(list[anchorIndex].scheduledDeparture || list[anchorIndex].scheduledArrival);
        const nextTime = parseScheduledTimeToday(list[anchorIndex + 1].scheduledArrival || list[anchorIndex + 1].scheduledDeparture);
        if (anchorTime && nextTime && nextTime > anchorTime) {
          fraction = (Date.now() - anchorTime) / (nextTime - anchorTime);
        }
      }

      if (fraction !== null) {
        fraction = Math.min(1, Math.max(0, fraction));
        topPx = rowMid(anchorRow) + fraction * (rowMid(nextRow) - rowMid(anchorRow));
      }
    }
 
    indicator.style.top = `${topPx}px`;
 
    if (scrollEl) {
      const targetScroll = topPx - scrollEl.clientHeight / 2;
      scrollEl.scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
    }
  });
}

// Metadata for the currently-rendered timeline rows, kept so the delay
// figures can be re-applied later (once the ML prediction resolves)
// without re-rendering/re-animating the whole list.
let journeyStopsMeta = [];

// Parses a "HH:MM" schedule string into a millisecond timestamp for
// "today" (used only for relative distance-between-two-times math, so
// the exact calendar date doesn't matter -- only the gap between them).
function parseScheduledTimeToday(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((timeStr || "").trim());
  if (!m) return null;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2])).getTime();
}

// Projects a delay (in minutes) onto every UPCOMING/CURRENT/NEXT stop's
// arrival & departure display. Passed stops are left alone since their
// actual time has already happened and shouldn't be relabelled with a
// prediction. Called once immediately with RailRadar's live delay, then
// again with the ML model's predicted impact once that resolves, so the
// numbers get progressively more accurate rather than staying blank.
function applyDelayToJourneyTimeline(delayMinutes) {
  const delayMin = Number(delayMinutes) || 0;

  journeyStopsMeta.forEach(({ index, state, schedArr, schedDep }) => {
    const arrEl = document.getElementById(`journeyArrDelay-${index}`);
    const depEl = document.getElementById(`journeyDepDelay-${index}`);
    if (!arrEl || !depEl) return;

    if (state === "passed" || delayMin <= 0) {
      arrEl.classList.add("hidden");
      depEl.classList.add("hidden");
      arrEl.textContent = "";
      depEl.textContent = "";
      return;
    }

    const adjArr = addMinutesToTimeString(schedArr, delayMin);
    const adjDep = addMinutesToTimeString(schedDep, delayMin);

    arrEl.textContent = adjArr ? `~${adjArr} (+${delayMin.toFixed(0)}m)` : "";
    depEl.textContent = adjDep ? `~${adjDep} (+${delayMin.toFixed(0)}m)` : "";
    arrEl.classList.toggle("hidden", !adjArr);
    depEl.classList.toggle("hidden", !adjDep);
  });
}
 
// Finds the next scheduled halting station after the train's current
// position. Prefers RailRadar's own authoritative `nextHalt` field
// (matched back into the halts-only route list by station code, since
// `nextHalt` itself doesn't carry full schedule data like
// scheduledArrival/scheduledDeparture). Falls back to sequence-based
// search that -- unlike the old strict "sequence + 1" check -- also
// works when the train's live position is a through-station that isn't
// itself a scheduled halt (so its sequence number doesn't line up
// exactly with the next halt's).
function findNextHaltStation(route, current, nextHalt) {
  const halts = (Array.isArray(route) ? route : []).filter((s) => s.isHalt === true);
  const list = (halts.length ? halts : route || []).slice().sort((a, b) => Number(a.sequence) - Number(b.sequence));
  if (list.length === 0) return null;

  if (nextHalt && nextHalt.stationCode) {
    const matched = list.find((s) => s.stationCode === nextHalt.stationCode);
    if (matched) return matched;
  }

  const currentSequence = Number(current.sequence);
  if (!isNaN(currentSequence)) {
    const exact = list.find((s) => Number(s.sequence) === currentSequence + 1);
    if (exact) return exact;
    const after = list.find((s) => Number(s.sequence) > currentSequence);
    if (after) return after;
  }
  return null;
}

// True unless the train is still sitting at its originating station
// AND its own scheduled departure time hasn't arrived yet -- i.e. it is
// simply resting there ahead of its slot, not actually running late.
// If the scheduled departure time HAS passed and it still hasn't left,
// that's a real delay and predictions are allowed as normal.
function hasTrainStarted(data) {
  const current = data.currentLocation || {};
  const route = Array.isArray(data.route) ? data.route : [];
  if (route.length === 0) return true; // not enough data to reason about -- don't block

  const halts = route.filter((s) => s.isHalt === true);
  const list = (halts.length ? halts : route).slice().sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const origin = list[0];
  if (!origin) return true;

  const atOrigin = Number(current.sequence) === Number(origin.sequence);
  const departedFlag = String(current.status || "").toLowerCase() === "departed";
  if (!atOrigin || departedFlag) return true;

  const schedDepTime = parseScheduledTimeToday(origin.scheduledDeparture || origin.scheduledArrival);
  if (schedDepTime !== null && Date.now() < schedDepTime) {
    return false; // genuinely hasn't started yet
  }
  return true;
}

function getStationDistanceKm(station) {
  if (!station) return null;
  const v = station.distanceFromOriginKm ?? station.distance ?? station.cumulativeDistanceKm ?? station.distanceFromSourceKm;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/* =========================================================
   ML PREDICTED ETA (separate microservice, additive only)
   ---------------------------------------------------------
   Calls the standalone delay-prediction FastAPI service (trained on
   ~1,900 historical stop records) with journey_progress / station /
   scheduled time / current delay derived from RailRadar's own live
   response -- it never touches railradar.py, app.py, or the API key,
   and it never overwrites RailRadar's live position/delay: it only
   fills in the separate "Predicted ETA" card. Called every time
   renderTrain() runs (manual track + every silent auto-refresh tick),
   so it updates whenever the train's live position changes.
   ========================================================= */
let mlRequestSeq = 0;

// Last successful ETA prediction, kept so the AI Incident Impact
// section (Operator Mode) can combine with "whatever train is
// currently tracked" without a second round-trip to ml-service.
let lastEtaPrediction = null; // { trainNumber, predictedArrival, targetLabel }

async function fetchAndRenderEtaPrediction(trainNumber, route, current, train, delay, nextStation, trainStarted = true) {
  const card = document.getElementById("mlEtaCard");
  const statusEl = document.getElementById("mlEtaStatus");
  if (!card) return;

  const mySeq = ++mlRequestSeq;

  const halts = (Array.isArray(route) ? route : [])
    .filter((s) => s.isHalt === true)
    .slice()
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const list = halts.length ? halts : (route || []).slice().sort((a, b) => Number(a.sequence) - Number(b.sequence));

  // The train hasn't reached its own scheduled departure time yet -- it's
  // simply resting at its originating station, not running late. Showing
  // an ETA/delay prediction here would be misleading, so skip the ML call
  // entirely (also saves quota) and say plainly when it's due to leave.
  if (!trainStarted) {
    const origin = list[0] || null;
    const depTime = origin ? formatTime(origin.scheduledDeparture || origin.scheduledArrival) : null;

    lastEtaPrediction = null;
    card.classList.add("unavailable");
    setElementText("mlEtaTarget", "Train has not yet departed its originating station.");
    setElementText("mlEtaValue", "--:--");
    setElementText("mlEtaRange", "Range: --:-- – --:--");
    setElementText("mlEtaConfidence", "--");
    setElementText("mlEtaImpact", "Additional impact: -- min");
    const reasonsEl = document.getElementById("mlEtaReasons");
    if (reasonsEl) reasonsEl.innerHTML = "";
    statusEl.textContent =
      depTime && depTime !== "--"
        ? `Scheduled to depart at ${depTime} — no delay prediction until it's actually underway.`
        : "Train has not yet departed — no delay prediction until it's actually underway.";
    statusEl.className = "find-status";

    applyDelayToJourneyTimeline(0);
    applyDelayToRouteTable(0, false);
    renderCombinedWindow();
    renderAbnormalDelayForTrackedTrain();
    return;
  }

  // Predict the ETA for the *next scheduled stop* (falls back to the
  // current halt if the train has none left) so the number updates as
  // the train physically moves between stations.
  const target = nextStation || list.find((s) => Number(s.sequence) === Number(current.sequence)) || null;

  const trainNumInt = parseInt(trainNumber, 10);
  const scheduledArrivalRaw = target ? (target.scheduledArrival || target.scheduledDeparture) : null;
  const scheduledArrival = scheduledArrivalRaw ? formatTime(scheduledArrivalRaw) : null;

  if (!target || !scheduledArrival || scheduledArrival === "--" || isNaN(trainNumInt)) {
    // Not enough schedule data for the ML model to predict a specific
    // ETA at this stop. Rather than always showing the same generic
    // "not enough data" message (which reads as broken even when the
    // train is simply on time), fall back to what we actually DO know
    // from live tracking: if RailRadar is already reporting a delay,
    // show that; if not, say plainly that no delay is predicted.
    const liveDelay = Number(delay) || 0;
    lastEtaPrediction = null;

    if (liveDelay > 0) {
      card.classList.remove("unavailable");
      setElementText("mlEtaTarget", "Live delay reported (not enough schedule data for a full ML prediction here)");
      setElementText("mlEtaValue", `+${liveDelay.toFixed(0)} min`);
      setElementText("mlEtaRange", "Range: based on current live tracking data");
      setElementText("mlEtaConfidence", "--");
      setElementText("mlEtaImpact", `Additional impact: +${liveDelay.toFixed(0)} min (live, not ML-predicted)`);
      const reasonsEl = document.getElementById("mlEtaReasons");
      if (reasonsEl) reasonsEl.innerHTML = "<li>Showing RailRadar's live delay — ML model needs more schedule data to predict further.</li>";
      statusEl.textContent = "";
      applyDelayToJourneyTimeline(liveDelay);
      applyDelayToRouteTable(liveDelay, true);
    } else {
      card.classList.add("unavailable");
      setElementText("mlEtaTarget", "Trained on ~1,900 historical stop records across ~2,000 trains.");
      setElementText("mlEtaValue", "--:--");
      setElementText("mlEtaRange", "Range: --:-- – --:--");
      setElementText("mlEtaConfidence", "--");
      setElementText("mlEtaImpact", "Additional impact: -- min");
      const reasonsEl = document.getElementById("mlEtaReasons");
      if (reasonsEl) reasonsEl.innerHTML = "";
      statusEl.textContent = "No ETA delay predicted.";
      statusEl.className = "find-status";
    }

    renderCombinedWindow();
    renderAbnormalDelayForTrackedTrain();
    return;
  }

  const targetIndex = list.findIndex((s) => s.stationCode === target.stationCode && Number(s.sequence) === Number(target.sequence));
  const journeyProgress = list.length > 1 && targetIndex !== -1 ? targetIndex / (list.length - 1) : 0;

  const payload = {
    train_number: trainNumInt,
    journey_progress: Math.min(1, Math.max(0, journeyProgress)),
    current_station_code: target.stationCode || null,
    scheduled_arrival: scheduledArrival,
    current_delay_min: Number(delay) || 0,
  };

  setElementText("mlEtaTarget", `Predicted for arrival at ${target.stationName || target.stationCode || "next stop"}`);
  statusEl.textContent = "Fetching prediction…";
  statusEl.className = "find-status";

  try {
    const response = await fetch(`${getMlApiBase()}/trains/${encodeURIComponent(String(trainNumInt))}/prediction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (mySeq !== mlRequestSeq) return; // a newer request has already superseded this one

    if (!response.ok) throw new Error(`ML service returned ${response.status}`);
    const prediction = await response.json();

    card.classList.remove("unavailable");

    lastEtaPrediction = {
      trainNumber: trainNumInt,
      predictedArrival: prediction.predictedArrival || null,
      targetLabel: target.stationName || target.stationCode || "next stop",
      lowerMin: prediction.additionalImpactLowerMin !== undefined ? Number(prediction.additionalImpactLowerMin) : null,
      upperMin: prediction.additionalImpactUpperMin !== undefined ? Number(prediction.additionalImpactUpperMin) : null,
      pointMin: prediction.additionalImpactMin !== undefined ? Number(prediction.additionalImpactMin) : null,
    };
    renderCombinedWindow();
    renderAbnormalDelayForTrackedTrain();
    renderTotalDelayRange();

    // Give every stop AFTER this one its own independent ML prediction
    // too (rather than just broadcasting this one number onto all of
    // them). Reuses this already-fetched result for `target`'s own row
    // instead of firing a duplicate identical request for it.
    fetchAndRenderPerStopPredictions(mySeq, trainNumInt, list, targetIndex, Number(delay) || 0, prediction);

    setElementText("mlEtaValue", prediction.predictedArrival || "--:--");
    setElementText("mlEtaRange", `Range: ${prediction.rangeStart || "--:--"} – ${prediction.rangeEnd || "--:--"}`);
    setElementText(
      "mlEtaConfidence",
      prediction.confidence !== undefined && prediction.confidence !== null ? `${prediction.confidence}% confidence` : "--"
    );
    setElementText(
      "mlEtaImpact",
      prediction.additionalImpactMin !== undefined
        ? `Additional impact: +${Number(prediction.additionalImpactMin).toFixed(0)} min`
        : "Additional impact: -- min"
    );

    // Refine the journey timeline's per-stop delay projections with the
    // ML model's actual predicted impact, now that it's back (this
    // replaces the rough "live delay" numbers applied immediately in
    // renderJourneyTimeline with a more accurate ML-informed figure).
    if (prediction.additionalImpactMin !== undefined && prediction.additionalImpactMin !== null) {
      const refinedDelay = Number(prediction.additionalImpactMin) || 0;
      applyDelayToJourneyTimeline(refinedDelay);
      applyDelayToRouteTable(refinedDelay, true);
    }

    const reasonsEl = document.getElementById("mlEtaReasons");
    if (reasonsEl) {
      const reasons = Array.isArray(prediction.reasons) ? prediction.reasons : [];
      reasonsEl.innerHTML = reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
    }

    statusEl.textContent = "";
  } catch (err) {
    if (mySeq !== mlRequestSeq) return;
    console.error("ML ETA prediction failed:", err);
    card.classList.add("unavailable");
    statusEl.textContent = "ETA prediction unavailable (ML service not reachable). Live tracking above is unaffected.";
    statusEl.className = "find-status error";
    lastEtaPrediction = null;
    renderCombinedWindow();
    renderAbnormalDelayForTrackedTrain();
  }
}

/* =========================================================
   PER-STOP ML PREDICTIONS (independent prediction for every
   remaining stop, not just the immediate next one)
   ---------------------------------------------------------
   fetchAndRenderEtaPrediction() above already calls ml-service for the
   single next stop and broadcasts that one number onto every remaining
   row via applyDelayToJourneyTimeline() so nothing sits blank. This
   fires one additional ml-service call PER remaining stop (in parallel)
   and, as each resolves, quietly upgrades that specific row from the
   shared broadcast estimate to its own independently-predicted number.
   Same "refine in place, never blank" pattern -- just applied per-row
   instead of to the whole list at once.

   Purely additive: never touches railradar.py, app.py, or the RailRadar
   API key/quota. Every request here goes to the local ml-service only.
   ========================================================= */
async function fetchAndRenderPerStopPredictions(mySeq, trainNumInt, list, targetIndex, currentDelay, targetPrediction) {
  if (!Array.isArray(list) || targetIndex === -1 || isNaN(trainNumInt)) return;

  // Reuses fetchAndRenderEtaPrediction's own request-sequence number
  // (bumped unconditionally at the top of EVERY call, including early-return
  // paths like "train not started") rather than a separate counter, so a
  // batch from an old refresh is recognised as stale the moment a new
  // renderTrain() cycle starts -- even if that new cycle's primary call
  // ends up failing or returning early.
  if (mySeq !== mlRequestSeq) return;

  // The row for `target` (the immediate next stop) already has its
  // prediction from the call that just resolved in fetchAndRenderEtaPrediction
  // -- reuse it instead of firing a duplicate request for the same stop.
  applyPerStopPrediction(targetIndex, targetPrediction);

  // Every scheduled stop AFTER target gets its own independent call.
  const remaining = list
    .map((stop, idx) => ({ stop, idx }))
    .filter(({ idx }) => idx > targetIndex);

  if (remaining.length === 0) return;

  await Promise.allSettled(
    remaining.map(async ({ stop, idx }) => {
      const scheduledArrivalRaw = stop.scheduledArrival || stop.scheduledDeparture;
      const scheduledArrival = scheduledArrivalRaw ? formatTime(scheduledArrivalRaw) : null;

      // Same "not enough schedule data" gate as the single-target call --
      // if a stop is missing a usable time, skip it silently and leave
      // whatever the broadcast estimate already put in that row.
      if (!scheduledArrival || scheduledArrival === "--") return;

      const journeyProgress = list.length > 1 ? idx / (list.length - 1) : 0;
      const payload = {
        train_number: trainNumInt,
        journey_progress: Math.min(1, Math.max(0, journeyProgress)),
        current_station_code: stop.stationCode || null,
        scheduled_arrival: scheduledArrival,
        current_delay_min: currentDelay,
      };

      try {
        const response = await fetch(`${getMlApiBase()}/trains/${encodeURIComponent(String(trainNumInt))}/prediction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (mySeq !== mlRequestSeq) return; // superseded by a newer refresh
        if (!response.ok) return; // leave the broadcast estimate in place for this row
        const prediction = await response.json();
        if (mySeq !== mlRequestSeq) return;
        applyPerStopPrediction(idx, prediction);
      } catch (err) {
        // Network/service error for this ONE stop -- every other stop's
        // call is independent and unaffected. Row just keeps showing the
        // broadcast estimate rather than going blank.
        console.error(`Per-stop ML prediction failed for ${stop.stationCode || idx}:`, err);
      }
    })
  );
}

// Upgrades a single journey-timeline row from the shared broadcast delay
// figure to its own independently-predicted number, and marks it visually
// (green, vs. the broadcast estimate's default colour) so it's clear which
// rows hold a real per-stop ML prediction vs. an inherited estimate.
function applyPerStopPrediction(index, prediction) {
  if (!prediction) return;
  const meta = journeyStopsMeta.find((m) => m.index === index);
  if (!meta || meta.state === "passed") return;

  const arrEl = document.getElementById(`journeyArrDelay-${index}`);
  const depEl = document.getElementById(`journeyDepDelay-${index}`);
  if (!arrEl || !depEl) return;

  const impactMin = Number(prediction.additionalImpactMin) || 0;
  const adjArr = addMinutesToTimeString(meta.schedArr, impactMin);
  const adjDep = addMinutesToTimeString(meta.schedDep, impactMin);

  const suffix = impactMin > 0 ? ` (+${impactMin.toFixed(0)}m · AI)` : " (on time · AI)";
  arrEl.textContent = adjArr ? `~${adjArr}${suffix}` : "";
  depEl.textContent = adjDep ? `~${adjDep}${suffix}` : "";
  arrEl.classList.toggle("hidden", !adjArr);
  depEl.classList.toggle("hidden", !adjDep);
  arrEl.classList.add("ml-refined");
  depEl.classList.add("ml-refined");

  if (prediction.confidence !== undefined && prediction.confidence !== null) {
    arrEl.title = `${prediction.confidence}% confidence`;
    depEl.title = `${prediction.confidence}% confidence`;
  }
}

/* =========================================================
   AI INCIDENT IMPACT PREDICTION (rule-based, separate 3rd
   microservice on port 8002 — Operator Mode only)
   ---------------------------------------------------------
   Sends the controller's incident report (type/severity/movement
   status/photo flag) to incident-service, gets back an additional
   delay range + confidence, then optionally combines that with
   whatever ETA prediction is currently held in `lastEtaPrediction`
   for the train being tracked in Live Tracking.
   ========================================================= */
let lastIncidentPrediction = null; // { minDelayMin, maxDelayMin } — most recent report, any train
// Every incident report is stored keyed by the train number it was filed
// for, so the abnormal-delay range only ever attaches to ETA predictions
// for that SAME train — reporting an incident for train A no longer bleeds
// into whatever train happens to be tracked afterwards.
let incidentPredictionsByTrain = {}; // { [trainNumber]: { minDelayMin, maxDelayMin } }

function addMinutesToTimeString(timeStr, minutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((timeStr || "").trim());
  if (!m) return null;
  const base = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
  base.setMinutes(base.getMinutes() + minutes);
  const hh = String(base.getHours()).padStart(2, "0");
  const mm = String(base.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function renderCombinedWindow() {
  const card = document.getElementById("combinedWindowCard");
  if (!card) return;

  // Only combine if the currently tracked train (Live Tracking) is the
  // SAME train number the incident report was filed for.
  const trainNum = lastEtaPrediction ? lastEtaPrediction.trainNumber : null;
  const incidentPred = trainNum !== null ? incidentPredictionsByTrain[trainNum] : null;

  if (!lastEtaPrediction || !lastEtaPrediction.predictedArrival || !incidentPred) {
    card.classList.add("hidden");
    return;
  }

  const base = lastEtaPrediction.predictedArrival;
  const { minDelayMin, maxDelayMin } = incidentPred;

  const windowStart = addMinutesToTimeString(base, minDelayMin);
  const windowEnd = addMinutesToTimeString(base, maxDelayMin);

  setElementText("combinedEtaBase", `${base} (${lastEtaPrediction.targetLabel}) — Train ${trainNum}`);
  setElementText("combinedIncidentRange", `${minDelayMin.toFixed(0)} – ${maxDelayMin.toFixed(0)} min`);
  setElementText(
    "combinedWindowResult",
    windowStart && windowEnd ? `${windowStart} – ${windowEnd}` : "--:-- – --:--"
  );

  card.classList.remove("hidden");
}

/* Mirrors the combined window, but rendered inside the Live Tracking
   "Predicted ETA · ML model" card itself, so anyone tracking a train
   sees the reported abnormal-delay range for THAT train, right next to
   its ML-predicted ETA — regardless of whether the incident was
   reported before or after the train was tracked. */
function renderAbnormalDelayForTrackedTrain() {
  const card = document.getElementById("mlAbnormalDelayCard");
  if (!card) {
    renderTotalDelayRange();
    return;
  }

  // Which train's abnormal-delay report (if any) to show here. Prefer the
  // train the ML ETA prediction resolved for, but fall back to whatever
  // train number is currently being tracked in Live Tracking -- this is
  // what makes the card still show a reported incident even when the ML
  // model couldn't produce a full ETA (e.g. no schedule data at this
  // point in the journey), instead of requiring BOTH to be present.
  const trainNum =
    lastEtaPrediction && lastEtaPrediction.trainNumber !== undefined
      ? lastEtaPrediction.trainNumber
      : activeTrainNumber !== null
      ? parseInt(activeTrainNumber, 10)
      : null;

  const incidentPred = trainNum !== null && !isNaN(trainNum) ? incidentPredictionsByTrain[trainNum] : null;

  if (!incidentPred) {
    card.classList.add("hidden");
    renderTotalDelayRange();
    return;
  }

  const { minDelayMin, maxDelayMin } = incidentPred;

  if (lastEtaPrediction && lastEtaPrediction.predictedArrival) {
    const base = lastEtaPrediction.predictedArrival;
    const windowStart = addMinutesToTimeString(base, minDelayMin);
    const windowEnd = addMinutesToTimeString(base, maxDelayMin);

    setElementText("mlAbnormalEtaBase", base);
    setElementText("mlAbnormalIncidentRange", `${minDelayMin.toFixed(0)} – ${maxDelayMin.toFixed(0)} min`);
    setElementText(
      "mlAbnormalWindowResult",
      windowStart && windowEnd ? `${windowStart} – ${windowEnd}` : "--:-- – --:--"
    );
  } else {
    // No ML ETA base to combine with yet -- still surface the reported
    // incident's own delay range for this train, rather than hiding the
    // card entirely until an ETA happens to resolve.
    setElementText("mlAbnormalEtaBase", "Not available yet");
    setElementText("mlAbnormalIncidentRange", `${minDelayMin.toFixed(0)} – ${maxDelayMin.toFixed(0)} min`);
    setElementText("mlAbnormalWindowResult", "ETA base not available yet — showing the reported delay range only.");
  }

  card.classList.remove("hidden");
  renderTotalDelayRange();
}

/* =========================================================
   TOTAL PREDICTED DELAY (ETA range + incident range, added)
   ---------------------------------------------------------
   Shown wherever both an ML ETA prediction and a reported incident
   exist for the currently tracked train: Track Train's ETA card,
   Operator Mode's combined-window card, and the journey timeline
   header. Falls back to ETA-only range if no incident is reported.
   ========================================================= */
function computeTotalDelayRange() {
  if (!lastEtaPrediction) return null;

  const etaLower = lastEtaPrediction.lowerMin !== null && lastEtaPrediction.lowerMin !== undefined
    ? lastEtaPrediction.lowerMin
    : lastEtaPrediction.pointMin || 0;
  const etaUpper = lastEtaPrediction.upperMin !== null && lastEtaPrediction.upperMin !== undefined
    ? lastEtaPrediction.upperMin
    : lastEtaPrediction.pointMin || 0;

  const incidentPred = incidentPredictionsByTrain[lastEtaPrediction.trainNumber];

  if (!incidentPred) {
    return { min: etaLower, max: etaUpper, hasIncident: false };
  }

  return {
    min: etaLower + incidentPred.minDelayMin,
    max: etaUpper + incidentPred.maxDelayMin,
    hasIncident: true,
  };
}

function renderTotalDelayRange() {
  const total = computeTotalDelayRange();
  const targets = ["mlTotalDelayValue", "combinedTotalDelayValue", "timelineTotalDelayValue"];

  targets.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const wrapper = el.closest(".total-delay-chip");
    if (!total) {
      if (wrapper) wrapper.classList.add("hidden");
      return;
    }
    el.textContent = `+${total.min.toFixed(0)}–${total.max.toFixed(0)} min`;
    if (wrapper) {
      wrapper.classList.remove("hidden");
      wrapper.title = total.hasIncident
        ? "ETA-predicted delay + reported incident delay, added together"
        : "ETA-predicted delay (no incident currently reported for this train)";
    }
  });
}

/* =========================================================
   YOUR AI DELAY IMPACT REPORTS (per-operator, persisted)
   ---------------------------------------------------------
   Every successful "Predict Impact (AI)" submission is saved here,
   tagged with the operator name that was logged in at the time.
   Logging back in under that same name later shows every report filed
   under it, with an "Add info" option that re-submits an updated
   type/severity/movement/photo to incident-service and recalculates
   the delay range for that specific report -- the original "Predict
   Impact (AI)" flow above still exists unchanged for filing brand new
   reports.
   ========================================================= */
function loadIncidentReports() {
  try {
    const raw = localStorage.getItem("trackline.incidentReports");
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

let incidentReports = loadIncidentReports();

function persistIncidentReports() {
  localStorage.setItem("trackline.incidentReports", JSON.stringify(incidentReports));
}

const INCIDENT_TYPE_LABELS = {
  signal_failure: "Signal / interlocking failure",
  track_obstruction: "Track obstruction",
  technical_fault: "Rolling stock / technical fault",
  medical_emergency: "Onboard medical emergency",
  ohe_power_issue: "OHE power / line block",
  severe_weather: "Severe weather / waterlogging",
  derailment: "Derailment",
  security_issue: "Security / law-and-order issue",
  level_crossing_issue: "Level crossing malfunction",
  other: "Other / unspecified",
};

function renderMyReports() {
  const listEl = document.getElementById("myReportsList");
  const countEl = document.getElementById("myReportsCount");
  if (!listEl) return;

  const session = loadOperatorSession();
  if (!session) {
    listEl.innerHTML = "";
    if (countEl) countEl.textContent = "";
    return;
  }

  // Matched on operator NAME only (trimmed, case-insensitive) since this
  // is a prototype login with no real account system -- typing the same
  // name back in is what "identifies" a returning operator here.
  const mine = incidentReports.filter(
    (r) => (r.operatorName || "").trim().toLowerCase() === (session.name || "").trim().toLowerCase()
  );

  if (countEl) countEl.textContent = `${mine.length} report${mine.length === 1 ? "" : "s"}`;

  if (mine.length === 0) {
    listEl.innerHTML = `<p class="empty-note">You haven't filed any AI Delay Impact reports yet — use "Predict Impact (AI)" further down to file one.</p>`;
    return;
  }

  listEl.innerHTML = mine
    .map((r) => {
      const historyHtml = (r.history || [])
        .map(
          (h) =>
            `<li>${escapeHtml(formatDateTime(h.at))} — ${escapeHtml(h.note || "Info added")} → recalculated to +${Number(h.minDelayMin).toFixed(0)}–${Number(h.maxDelayMin).toFixed(0)} min</li>`
        )
        .join("");

      return `
      <div class="incident-row my-report-row">
        <div>
          <div class="incident-row-type">Train ${escapeHtml(String(r.trainNumber))} — ${escapeHtml(INCIDENT_TYPE_LABELS[r.incidentType] || r.incidentType || "Unknown")}</div>
          <div class="incident-row-meta">Severity: ${escapeHtml(r.severity || "--")} · Movement: ${escapeHtml(r.movementStatus || "--")} · Help arrived: ${escapeHtml(r.helpArrived || "no")}</div>
          <div class="incident-row-meta">Filed ${escapeHtml(formatDateTime(r.createdAt))}${r.updatedAt && r.updatedAt !== r.createdAt ? " · updated " + escapeHtml(formatDateTime(r.updatedAt)) : ""}</div>
          <div class="incident-chip-row">
            <span class="incident-delay-chip">Current: +${Number(r.minDelayMin).toFixed(0)}–${Number(r.maxDelayMin).toFixed(0)} min</span>
            ${r.confidence !== undefined && r.confidence !== null ? `<span class="incident-delay-chip">${escapeHtml(String(r.confidence))}% confidence</span>` : ""}
          </div>
          ${historyHtml ? `<ul class="incident-predict-reasons">${historyHtml}</ul>` : ""}
        </div>
        <button class="ghost-btn small add-info-btn" data-report-id="${escapeHtml(r.id)}" type="button">Add info</button>
      </div>
      <div class="add-info-form hidden" id="addInfoForm-${escapeHtml(r.id)}"></div>`;
    })
    .join("");

  listEl.querySelectorAll(".add-info-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleAddInfoForm(btn.dataset.reportId));
  });
}

function toggleAddInfoForm(reportId) {
  const container = document.getElementById(`addInfoForm-${reportId}`);
  if (!container) return;

  const isOpen = !container.classList.contains("hidden") && container.innerHTML.trim() !== "";
  if (isOpen) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const report = incidentReports.find((r) => r.id === reportId);
  if (!report) return;

  const typeOptions = Object.entries(INCIDENT_TYPE_LABELS)
    .map(([val, label]) => `<option value="${val}" ${report.incidentType === val ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");

  container.innerHTML = `
    <div class="search-row wrap add-info-fields">
      <div class="pill-field small">
        <label>Incident type</label>
        <select class="addInfoType">${typeOptions}</select>
      </div>
      <div class="pill-field small">
        <label>Scale / severity</label>
        <select class="addInfoSeverity">
          <option value="minor" ${report.severity === "minor" ? "selected" : ""}>Minor</option>
          <option value="moderate" ${report.severity === "moderate" ? "selected" : ""}>Moderate</option>
          <option value="major" ${report.severity === "major" ? "selected" : ""}>Major</option>
          <option value="critical" ${report.severity === "critical" ? "selected" : ""}>Critical</option>
        </select>
      </div>
      <div class="pill-field small">
        <label>Train's live movement</label>
        <select class="addInfoMovement">
          <option value="normal" ${report.movementStatus === "normal" ? "selected" : ""}>Normal speed</option>
          <option value="slow" ${report.movementStatus === "slow" ? "selected" : ""}>Moving slowly</option>
          <option value="stopped" ${report.movementStatus === "stopped" ? "selected" : ""}>Stopped / at rest</option>
        </select>
      </div>
      <div class="pill-field small">
        <label><input type="checkbox" class="addInfoPhoto" ${report.hasPhoto ? "checked" : ""}> Photo attached</label>
      </div>
      <div class="pill-field small">
        <label>Reinforcement / help arrived?</label>
        <select class="addInfoHelpArrived">
          <option value="no" ${report.helpArrived === "no" || !report.helpArrived ? "selected" : ""}>No</option>
          <option value="soon" ${report.helpArrived === "soon" ? "selected" : ""}>Soon / on the way</option>
          <option value="yes" ${report.helpArrived === "yes" ? "selected" : ""}>Yes</option>
        </select>
      </div>
      <div class="pill-field small" style="flex:1; min-width:220px;">
        <label>What's changed / new info</label>
        <input type="text" class="addInfoNote" placeholder="e.g. Escalated to major, train now fully stopped">
      </div>
    </div>
    <button class="primary-btn small recalc-btn" type="button" style="margin-top:8px;">Recalculate delay</button>
    <p class="find-status addInfoStatus"></p>
  `;
  container.classList.remove("hidden");

  container.querySelector(".recalc-btn").addEventListener("click", async () => {
    const statusEl = container.querySelector(".addInfoStatus");
    const newType = container.querySelector(".addInfoType").value;
    const newSeverity = container.querySelector(".addInfoSeverity").value;
    const newMovement = container.querySelector(".addInfoMovement").value;
    const newHasPhoto = container.querySelector(".addInfoPhoto").checked;
    const newHelpArrived = container.querySelector(".addInfoHelpArrived").value;
    const noteText = container.querySelector(".addInfoNote").value.trim();

    statusEl.textContent = "Recalculating…";
    statusEl.className = "find-status";

    try {
      const response = await fetch(`${getIncidentApiBase()}/incidents/prediction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incident_known: true,
          incident_type: newType,
          severity: newSeverity,
          movement_status: newMovement,
          has_photo: newHasPhoto,
          help_arrived: newHelpArrived,
          notes: noteText || report.notes || null,
        }),
      });
      if (!response.ok) throw new Error(`Incident service returned ${response.status}`);
      const prediction = await response.json();

      report.incidentType = newType;
      report.severity = newSeverity;
      report.movementStatus = newMovement;
      report.hasPhoto = newHasPhoto;
      report.helpArrived = newHelpArrived;
      if (noteText) report.notes = report.notes ? `${report.notes} | ${noteText}` : noteText;
      report.minDelayMin = Number(prediction.minDelayMin) || 0;
      report.maxDelayMin = Number(prediction.maxDelayMin) || 0;
      report.confidence = prediction.confidence;
      report.reasons = Array.isArray(prediction.reasons) ? prediction.reasons : [];
      report.updatedAt = new Date().toISOString();
      report.history = report.history || [];
      report.history.push({
        at: report.updatedAt,
        note: noteText || "Info updated",
        minDelayMin: report.minDelayMin,
        maxDelayMin: report.maxDelayMin,
      });

      persistIncidentReports();

      // Keep the train-keyed map (used by Live Tracking's abnormal-delay
      // card and the Operator combined-window card) in sync, so the
      // recalculated number shows up everywhere immediately.
      incidentPredictionsByTrain[report.trainNumber] = {
        minDelayMin: report.minDelayMin,
        maxDelayMin: report.maxDelayMin,
      };
      renderCombinedWindow();
      renderAbnormalDelayForTrackedTrain();

      renderMyReports();
    } catch (err) {
      console.error("Recalculation failed:", err);
      statusEl.textContent = "Recalculation failed (incident-service not reachable). Check the API base URL in Preferences.";
      statusEl.className = "find-status error";
    }
  });
}

function initIncidentAiPrediction() {
  const yesBtn = document.getElementById("incidentKnownYesBtn");
  const noBtn = document.getElementById("incidentKnownNoBtn");
  const fields = document.getElementById("incidentAiFields");
  const predictBtn = document.getElementById("predictImpactBtn");
  const statusEl = document.getElementById("incidentPredictStatus");
  const resultEl = document.getElementById("incidentPredictResult");
  if (!predictBtn) return;

  let incidentKnown = true;

  function setKnown(val) {
    incidentKnown = val === "yes";
    yesBtn.classList.toggle("active", incidentKnown);
    noBtn.classList.toggle("active", !incidentKnown);
    fields.classList.toggle("hidden", !incidentKnown);
  }

  yesBtn.addEventListener("click", () => setKnown("yes"));
  noBtn.addEventListener("click", () => setKnown("no"));

  predictBtn.addEventListener("click", async () => {
    const trainNumberEl = document.getElementById("aiIncidentTrainNumber");
    const trainNumberInt = parseInt((trainNumberEl ? trainNumberEl.value : "").trim(), 10);

    if (isNaN(trainNumberInt)) {
      statusEl.textContent = "Enter the train number this incident is affecting before predicting impact.";
      statusEl.className = "find-status error";
      resultEl.classList.add("hidden");
      return;
    }

    const photoInput = document.getElementById("aiIncidentPhoto");
    const payload = {
      incident_known: incidentKnown,
      incident_type: incidentKnown ? document.getElementById("aiIncidentType").value : null,
      severity: incidentKnown ? document.getElementById("aiSeverity").value : null,
      movement_status: incidentKnown ? document.getElementById("aiMovementStatus").value : null,
      has_photo: incidentKnown && !!(photoInput && photoInput.files && photoInput.files.length),
      help_arrived: incidentKnown ? document.getElementById("aiHelpArrived").value : null,
      notes: incidentKnown ? document.getElementById("aiIncidentNotes").value.trim() || null : null,
    };

    statusEl.textContent = "Predicting impact…";
    statusEl.className = "find-status";
    resultEl.classList.add("hidden");

    try {
      const response = await fetch(`${getIncidentApiBase()}/incidents/prediction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Incident service returned ${response.status}`);
      const prediction = await response.json();

      lastIncidentPrediction = {
        minDelayMin: Number(prediction.minDelayMin) || 0,
        maxDelayMin: Number(prediction.maxDelayMin) || 0,
      };
      // Keyed by train number, so this report only ever combines with
      // ETA predictions for THIS specific train, whenever it's tracked.
      incidentPredictionsByTrain[trainNumberInt] = lastIncidentPrediction;

      setElementText(
        "incidentPredictRange",
        `+${lastIncidentPrediction.minDelayMin.toFixed(0)}–${lastIncidentPrediction.maxDelayMin.toFixed(0)} min`
      );
      const rangeEl = document.getElementById("incidentPredictRange");
      if (rangeEl && !rangeEl.querySelector("small")) {
        const small = document.createElement("small");
        small.textContent = "Additional delay range";
        rangeEl.appendChild(small);
      }
      setElementText(
        "incidentPredictConfidence",
        prediction.confidence !== undefined ? `${prediction.confidence}% confidence` : "--"
      );

      const reasonsEl = document.getElementById("incidentPredictReasons");
      const reasons = Array.isArray(prediction.reasons) ? prediction.reasons : [];
      reasonsEl.innerHTML = reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("");

      resultEl.classList.remove("hidden");
      statusEl.textContent = "";

      renderCombinedWindow();
      renderAbnormalDelayForTrackedTrain();

      // Persist this as a report under the logged-in operator's name, so
      // it shows up in "Your AI Delay Impact reports" above, and can be
      // found again later (even after logging out/in) to add more info.
      //
      // If this operator already has an open report for THIS train,
      // update it in place instead of filing a duplicate -- re-running
      // "Predict Impact (AI)" for a train you've already reported (e.g.
      // after tweaking a field and clicking it again) is functionally
      // the same as using "Add info" on the existing report, so it
      // should behave the same way rather than piling up near-identical
      // entries.
      const session = loadOperatorSession();
      const operatorNameNorm = (session ? session.name : "Unknown").trim().toLowerCase();
      const existing = incidentReports.find(
        (r) => r.trainNumber === trainNumberInt && (r.operatorName || "").trim().toLowerCase() === operatorNameNorm
      );

      if (existing) {
        existing.incidentKnown = incidentKnown;
        existing.incidentType = payload.incident_type;
        existing.severity = payload.severity;
        existing.movementStatus = payload.movement_status;
        existing.hasPhoto = payload.has_photo;
        existing.helpArrived = payload.help_arrived;
        if (payload.notes) existing.notes = payload.notes;
        existing.minDelayMin = lastIncidentPrediction.minDelayMin;
        existing.maxDelayMin = lastIncidentPrediction.maxDelayMin;
        existing.confidence = prediction.confidence;
        existing.reasons = reasons;
        existing.updatedAt = new Date().toISOString();
        existing.history = existing.history || [];
        existing.history.push({
          at: existing.updatedAt,
          note: "Re-submitted via Predict Impact (AI)",
          minDelayMin: existing.minDelayMin,
          maxDelayMin: existing.maxDelayMin,
        });
      } else {
        incidentReports.unshift({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          trainNumber: trainNumberInt,
          operatorName: session ? session.name : "Unknown",
          operatorId: session && session.id ? session.id : "",
          incidentKnown,
          incidentType: payload.incident_type,
          severity: payload.severity,
          movementStatus: payload.movement_status,
          hasPhoto: payload.has_photo,
          helpArrived: payload.help_arrived,
          notes: payload.notes,
          minDelayMin: lastIncidentPrediction.minDelayMin,
          maxDelayMin: lastIncidentPrediction.maxDelayMin,
          confidence: prediction.confidence,
          reasons,
          history: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      persistIncidentReports();
      renderMyReports();
    } catch (err) {
      console.error("Incident impact prediction failed:", err);
      statusEl.textContent = "Prediction unavailable (incident-service not reachable). Check the API base URL in Preferences.";
      statusEl.className = "find-status error";
      lastIncidentPrediction = null;
      delete incidentPredictionsByTrain[trainNumberInt];
      renderCombinedWindow();
      renderAbnormalDelayForTrackedTrain();
    }
  });
}

/* =========================================================
   SCHEDULED ROUTE TABLE
   (Station | Sched Arrival | Sched Departure | Platform | Day | ETA)
   ---------------------------------------------------------
   The ETA column starts out showing each stop's own scheduled time,
   then gets refined in place by applyDelayToRouteTable() -- first with
   RailRadar's live delay, then with the ML model's predicted impact
   once that resolves (mirrors how the journey timeline's per-stop
   delay figures are progressively refined).
   ========================================================= */
let routeTableMeta = [];

function renderRouteTable(route, current) {
  const body = document.getElementById("routeTableBody");
  if (!body) return;
  body.innerHTML = "";
  routeTableMeta = [];
 
  const currentSequence = Number(current.sequence);
  const haltsOnly = route.filter((s) => s.isHalt === true);
  const list = haltsOnly.length ? haltsOnly : route;
 
  list.forEach((station, i) => {
    const seq = Number(station.sequence);
    let state = "upcoming";
    if (!isNaN(currentSequence)) {
      if (seq < currentSequence) state = "completed";
      else if (seq === currentSequence) state = "current";
    }
 
    const day = station.day ?? station.dayCount ?? station.dayOfJourney ?? station.dayOffset;
    const dayLabel = day !== undefined && day !== null ? `Day ${day}` : "Day 1";
    const platform = station.platform || station.platformNumber || station.platformNo || station.expectedPlatform || "—";
 
    const schedArr = formatTime(station.scheduledArrival);
    const schedDep = formatTime(station.scheduledDeparture);
    // ETA is projected off the scheduled ARRIVAL where a train has one
    // (i.e. every stop except the origin), falling back to the
    // scheduled DEPARTURE only for the origin itself.
    const baseTime = schedArr !== "--" ? schedArr : schedDep;
    routeTableMeta.push({ index: i, state, baseTime, hasBase: baseTime !== "--" });
 
    const tr = document.createElement("tr");
    tr.className = state;
    tr.innerHTML = `
      <td>
        <div class="station-cell">
          <span class="st-name">${state === "current" ? '<span class="current-dot"></span>' : ""}${escapeHtml(
      station.stationName || "—"
    )}</span>
          <span class="st-code">${escapeHtml(station.stationCode || "")}</span>
        </div>
      </td>
      <td class="mono">${schedArr}</td>
      <td class="mono">${schedDep}</td>
      <td class="mono">${escapeHtml(String(platform))}</td>
      <td class="mono">${escapeHtml(dayLabel)}</td>
      <td class="mono eta-cell" id="routeEta-${i}">${baseTime !== "--" ? baseTime : "—"}</td>
    `;
    body.appendChild(tr);
  });
}

// Projects a delay (in minutes) onto every stop's ETA column, same
// approach as applyDelayToJourneyTimeline: already-passed stops keep
// their plain scheduled time, and a `trainStarted = false` shows a
// "not departed yet" note instead of a (misleading) delay projection.
function applyDelayToRouteTable(delayMinutes, trainStarted) {
  const delayMin = Number(delayMinutes) || 0;

  routeTableMeta.forEach(({ index, state, baseTime, hasBase }) => {
    const el = document.getElementById(`routeEta-${index}`);
    if (!el) return;

    if (!hasBase) {
      el.textContent = "—";
      return;
    }
    if (state === "completed") {
      el.textContent = baseTime;
      return;
    }
    if (!trainStarted) {
      el.textContent = `${baseTime} (not departed)`;
      return;
    }
    if (delayMin <= 0) {
      el.textContent = baseTime;
      return;
    }

    const adj = addMinutesToTimeString(baseTime, delayMin);
    el.textContent = adj ? `~${adj} (+${delayMin.toFixed(0)}m)` : baseTime;
  });
}
 
/* =========================================================
   FARE & CLASS AVAILABILITY  (on demand only — see requirement:
   never fetched per result row, only once a train is selected)
   ========================================================= */
function initFareToggle() {
  const toggleBtn = document.getElementById("fareToggleBtn");
  const section = document.getElementById("fareSection");
  const fetchBtn = document.getElementById("fareFetchBtn");
  if (toggleBtn && section) {
    toggleBtn.addEventListener("click", () => section.classList.toggle("hidden"));
  }
  if (fetchBtn) {
    fetchBtn.addEventListener("click", fetchFareForActiveTrain);
  }
}
 
async function fetchFareForActiveTrain() {
  const from = document.getElementById("fareFrom").value.trim().toUpperCase();
  const to = document.getElementById("fareTo").value.trim().toUpperCase();
  const date = document.getElementById("fareDate").value;
  const quota = document.getElementById("fareQuota").value;
  const resultEl = document.getElementById("fareResult");
 
  if (!activeTrainNumber || !from || !to) {
    resultEl.innerHTML = `<p class="empty-note">Track a train, then enter both a from and to station code.</p>`;
    return;
  }
 
  resultEl.innerHTML = `<p class="empty-note">Checking fares…</p>`;
  const data = await fetchFare(activeTrainNumber, from, to, date, quota);
  renderFareResult(data, resultEl);
}
 
async function fetchFare(trainNumber, from, to, date, quota) {
  try {
    const params = new URLSearchParams({ from_station: from, to_station: to });
    if (date) params.set("date", date);
    if (quota) params.set("quota", quota);
    const res = await fetch(`${getApiBase()}/trains/${encodeURIComponent(trainNumber)}/fare?${params.toString()}`);
    return await res.json();
  } catch (err) {
    return { success: false, error: { message: err.message || "Could not reach backend." } };
  }
}
 
function renderFareResult(result, el) {
  if (!el) return;
  if (!result || !result.success) {
    const msg = (result && result.error && result.error.message) || "Fare data unavailable for this leg.";
    el.innerHTML = `<p class="empty-note">${escapeHtml(msg)}</p>`;
    return;
  }
 
  const data = result.data || {};
  const classes = data.classes || data.fares || data.availability || [];
 
  if (!Array.isArray(classes) || classes.length === 0) {
    el.innerHTML = `<p class="empty-note">No class availability returned for this leg.</p>`;
    return;
  }
 
  el.innerHTML = `<div class="fare-class-list">${classes
    .map((c) => {
      const name = c.className || c.class || c.code || "—";
      const fareValue = c.fare ?? c.price ?? c.totalFare;
      const fareText = fareValue !== undefined && fareValue !== null ? `₹${fareValue}` : "—";
      const availText = c.availability || c.status || "Availability unknown";
      return `
      <div class="fare-class-card">
        <div class="cls-name">${escapeHtml(String(name))}</div>
        <div class="cls-fare">${escapeHtml(fareText)}</div>
        <div class="cls-avail">${escapeHtml(String(availText))}</div>
      </div>`;
    })
    .join("")}</div>`;
}
 
/* =========================================================
   OPERATIONS — STANDALONE FARE CHECKER
   ========================================================= */
function initOperationsFareChecker() {
  const btn = document.getElementById("opsFareBtn");
  if (!btn) return;
 
  btn.addEventListener("click", async () => {
    const trainNumber = document.getElementById("opsTrainNumber").value.trim();
    const from = document.getElementById("opsFrom").value.trim().toUpperCase();
    const to = document.getElementById("opsTo").value.trim().toUpperCase();
    const date = document.getElementById("opsDate").value;
    const quota = document.getElementById("opsQuota").value;
    const statusEl = document.getElementById("opsStatus");
    const resultEl = document.getElementById("opsFareResult");
 
    if (!trainNumber || !from || !to) {
      statusEl.textContent = "Fill in a train number and both station codes to check fares.";
      statusEl.className = "find-status error";
      return;
    }
 
    statusEl.textContent = "Checking fares…";
    statusEl.className = "find-status";
    resultEl.innerHTML = "";
 
    const data = await fetchFare(trainNumber, from, to, date, quota);
    if (data.success) {
      statusEl.textContent = `Fare loaded for train ${trainNumber}.`;
      statusEl.className = "find-status ok";
    } else {
      statusEl.textContent = (data.error && data.error.message) || "Could not load fare data.";
      statusEl.className = "find-status error";
    }
    renderFareResult(data, resultEl);
  });
}
 
/* =========================================================
   OPERATOR MODE — DUMMY LOGIN (prototype only, no real auth)
   ---------------------------------------------------------
   Client-side only, tab-scoped (sessionStorage). Any name/ID/password
   is accepted -- this never calls a backend endpoint and never touches
   RailRadar or the API key. Purely gates the Operator Mode UI.
   ========================================================= */
function loadOperatorSession() {
  try {
    const raw = sessionStorage.getItem("trackline.operatorSession");
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}
 
function initOperatorLogin() {
  const gate = document.getElementById("operatorLoginGate");
  const content = document.getElementById("operatorContent");
  const loginBtn = document.getElementById("operatorLoginBtn");
  const logoutBtn = document.getElementById("operatorLogoutBtn");
  const statusEl = document.getElementById("operatorLoginStatus");
  const sessionLabel = document.getElementById("operatorSessionLabel");
  if (!gate || !content || !loginBtn) return;
 
  function showLoggedIn(session) {
    gate.classList.add("hidden");
    content.classList.remove("hidden");
    sessionLabel.textContent = `Logged in as ${session.name}${session.id ? " · " + session.id : ""}`;
    renderMyReports();
  }
 
  function showLoggedOut() {
    gate.classList.remove("hidden");
    content.classList.add("hidden");
  }
 
  const existing = loadOperatorSession();
  if (existing) {
    showLoggedIn(existing);
  } else {
    showLoggedOut();
  }
 
  loginBtn.addEventListener("click", () => {
    const name = document.getElementById("operatorName").value.trim();
    const id = document.getElementById("operatorId").value.trim();
    const password = document.getElementById("operatorPassword").value;
 
    if (!name || !password) {
      statusEl.textContent = "Enter a name and any password to continue (prototype login).";
      statusEl.className = "find-status error";
      return;
    }
 
    const session = { name, id, loggedInAt: new Date().toISOString() };
    sessionStorage.setItem("trackline.operatorSession", JSON.stringify(session));
    statusEl.textContent = "";
    showLoggedIn(session);
  });
 
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      sessionStorage.removeItem("trackline.operatorSession");
      document.getElementById("operatorPassword").value = "";
      showLoggedOut();
    });
  }
}
 
/* =========================================================
   GENERIC STATION TYPEAHEAD
   ---------------------------------------------------------
   Same /stations/search endpoint the All Trains pills use, but doesn't
   force a chip selection -- the operator can type free text (a section
   name, "between X and Y", etc.) OR click a suggestion to autofill a
   clean "CODE - Name" value. Reused for the incident "near station" and
   "towards station" fields.
   ========================================================= */
function initStationTypeahead(inputId, boxId) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(boxId);
  if (!input || !box) return;
 
  let debounceTimer = null;
 
  input.addEventListener("input", () => {
    const query = input.value.trim();
    clearTimeout(debounceTimer);
 
    if (query.length < 2) {
      box.classList.remove("show");
      box.innerHTML = "";
      return;
    }
 
    debounceTimer = setTimeout(async () => {
      try {
        const response = await fetch(`${getApiBase()}/stations/search?q=${encodeURIComponent(query)}&limit=8`);
        const result = await response.json();
        if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
          box.classList.remove("show");
          box.innerHTML = "";
          return;
        }
 
        box.innerHTML = "";
        result.data.forEach((station) => {
          const item = document.createElement("div");
          item.className = "suggestion-item";
          item.innerHTML = `<span class="code">${escapeHtml(station.code)}</span>${escapeHtml(station.name)}<span class="city">${escapeHtml(
            station.city || ""
          )}</span>`;
          item.addEventListener("click", () => {
            input.value = `${station.code} - ${station.name}`;
            box.classList.remove("show");
            box.innerHTML = "";
          });
          box.appendChild(item);
        });
        box.classList.add("show");
      } catch (err) {
        console.error("Station search failed:", err);
      }
    }, 250);
  });
 
  document.addEventListener("click", (event) => {
    if (!box.contains(event.target) && event.target !== input) {
      box.classList.remove("show");
    }
  });
}
 
/* =========================================================
   OPERATOR MODE — INCIDENT REPORTING (UI/TESTING FEATURE ONLY)
   ---------------------------------------------------------
   Deliberately self-contained: reads/writes only its own localStorage
   key, never touches `activeTrainNumber`, `selectedService`,
   `sessionWatchLog`, RailRadar responses, or anything rendered by
   loadTrain()/renderTrain(). Logging a scenario here cannot change any
   ETA, delay, live position, or ML prediction shown elsewhere in the app.
   ========================================================= */
function loadIncidents() {
  try {
    const raw = localStorage.getItem("trackline.incidents");
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}
 
let incidentLog = loadIncidents();
 
function persistIncidents() {
  localStorage.setItem("trackline.incidents", JSON.stringify(incidentLog));
}
 
function renderIncidents() {
  const el = document.getElementById("incidentLog");
  if (!el) return;
 
  if (incidentLog.length === 0) {
    el.innerHTML = `<p class="empty-note">No incidents logged yet.</p>`;
    return;
  }
 
  el.innerHTML = incidentLog
    .map((inc, i) => {
      const locationBits = [];
      if (inc.station) locationBits.push(escapeHtml(inc.station));
      if (inc.distance) locationBits.push(`${escapeHtml(String(inc.distance))} km`);
      if (inc.direction) locationBits.push(escapeHtml(inc.direction));
      if (inc.towards) locationBits.push(`towards ${escapeHtml(inc.towards)}`);
 
      const chips = [];
      if (inc.speedLimit) chips.push(`<span class="incident-delay-chip">Restricted to: ${escapeHtml(String(inc.speedLimit))} km/h</span>`);
      if (inc.delay) chips.push(`<span class="incident-delay-chip">Est. delay: ${escapeHtml(String(inc.delay))} min</span>`);
      if (inc.clearance) chips.push(`<span class="incident-delay-chip">Est. clearance: ${escapeHtml(String(inc.clearance))} min</span>`);
 
      return `
    <div class="incident-row" data-index="${i}">
      <div>
        <div class="incident-row-type">${escapeHtml(inc.type)}</div>
        <div class="incident-row-meta">${locationBits.length ? locationBits.join(" · ") : "—"}</div>
        <div class="incident-row-meta">${inc.loggedBy ? "Logged by " + escapeHtml(inc.loggedBy) : ""}</div>
        <div class="incident-chip-row">${chips.join("")}</div>
      </div>
      <div class="incident-row-time">${escapeHtml(formatDateTime(inc.loggedAt))}</div>
      <button class="incident-row-remove" data-remove="${i}" type="button" aria-label="Remove incident">✕</button>
    </div>`;
    })
    .join("");
 
  el.querySelectorAll(".incident-row-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      incidentLog.splice(Number(btn.dataset.remove), 1);
      persistIncidents();
      renderIncidents();
    });
  });
}
 
const SLOW_DOWN_INCIDENT_TYPE = "Speed Restriction / Caution Order (Slow Down)";
 
function initIncidentSpeedLimitToggle() {
  const typeEl = document.getElementById("incidentType");
  const speedField = document.getElementById("incidentSpeedLimitField");
  if (!typeEl || !speedField) return;
 
  const sync = () => {
    speedField.classList.toggle("hidden", typeEl.value !== SLOW_DOWN_INCIDENT_TYPE);
  };
  typeEl.addEventListener("change", sync);
  sync();
}
 
function initIncidentForm() {
  const btn = document.getElementById("logIncidentBtn");
  const clearBtn = document.getElementById("clearIncidentsBtn");
  const statusEl = document.getElementById("incidentStatus");
  if (!btn) return;
 
  btn.addEventListener("click", () => {
    const type = document.getElementById("incidentType").value;
    const station = document.getElementById("incidentStation").value.trim();
    const distance = document.getElementById("incidentDistance").value.trim();
    const direction = document.getElementById("incidentDirection").value;
    const towards = document.getElementById("incidentTowards").value.trim();
    const speedLimit = document.getElementById("incidentSpeedLimit").value.trim();
    const delay = document.getElementById("incidentDelay").value.trim();
    const clearance = document.getElementById("incidentClearance").value.trim();
 
    if (!station) {
      statusEl.textContent = "Enter or select a near station to log this scenario.";
      statusEl.className = "find-status error";
      return;
    }
    if (type === SLOW_DOWN_INCIDENT_TYPE && !speedLimit) {
      statusEl.textContent = "Enter the restricted speed limit for a slow-down / caution order scenario.";
      statusEl.className = "find-status error";
      return;
    }
 
    const session = loadOperatorSession();
 
    incidentLog.unshift({
      type,
      station,
      distance,
      direction,
      towards,
      speedLimit: type === SLOW_DOWN_INCIDENT_TYPE ? speedLimit : "",
      delay,
      clearance,
      loggedBy: session ? `${session.name}${session.id ? " (" + session.id + ")" : ""}` : "",
      loggedAt: new Date().toISOString(),
    });
    persistIncidents();
    renderIncidents();
 
    document.getElementById("incidentStation").value = "";
    document.getElementById("incidentDistance").value = "";
    document.getElementById("incidentTowards").value = "";
    document.getElementById("incidentSpeedLimit").value = "";
    document.getElementById("incidentDelay").value = "";
    document.getElementById("incidentClearance").value = "";
 
    statusEl.textContent = "Scenario logged locally. This does not affect ETA, ML predictions, or live tracking.";
    statusEl.className = "find-status ok";
  });
 
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      incidentLog = [];
      persistIncidents();
      renderIncidents();
      statusEl.textContent = "Incident log cleared.";
      statusEl.className = "find-status ok";
    });
  }
}
 
/* =========================================================
   PREFERENCES
   ========================================================= */
function initPreferencesForm() {
  const apiBaseEl = document.getElementById("prefApiBase");
  const mlApiBaseEl = document.getElementById("prefMlApiBase");
  const incidentApiBaseEl = document.getElementById("prefIncidentApiBase");
  const refreshEl = document.getElementById("prefRefreshSeconds");
  const quotaEl = document.getElementById("prefDefaultQuota");
  if (!apiBaseEl) return;
 
  apiBaseEl.value = prefs.apiBase;
  if (mlApiBaseEl) mlApiBaseEl.value = prefs.mlApiBase;
  if (incidentApiBaseEl) incidentApiBaseEl.value = prefs.incidentApiBase;
  refreshEl.value = prefs.refreshSeconds;
  quotaEl.value = prefs.defaultQuota;
 
  const fareQuotaEl = document.getElementById("fareQuota");
  const opsQuotaEl = document.getElementById("opsQuota");
  if (fareQuotaEl) fareQuotaEl.value = prefs.defaultQuota;
  if (opsQuotaEl) opsQuotaEl.value = prefs.defaultQuota;
 
  document.getElementById("savePrefsBtn").addEventListener("click", () => {
    prefs.apiBase = apiBaseEl.value.trim() || DEFAULT_API_BASE;
    prefs.mlApiBase = (mlApiBaseEl ? mlApiBaseEl.value.trim() : "") || DEFAULT_ML_API_BASE;
    prefs.incidentApiBase = (incidentApiBaseEl ? incidentApiBaseEl.value.trim() : "") || DEFAULT_INCIDENT_API_BASE;
    prefs.refreshSeconds = Number(refreshEl.value) || 45;
    prefs.defaultQuota = quotaEl.value;
    persistPrefs();
 
    const statusEl = document.getElementById("prefsStatus");
    statusEl.textContent = "Preferences saved.";
    statusEl.className = "find-status ok";
 
    checkConnection();
    loadNetworkStats();
  });
 
  document.getElementById("clearSessionBtn").addEventListener("click", () => {
    sessionWatchLog = [];
    renderWatchLog();
    renderOverviewRecent();
    const statEl = document.getElementById("statServiceWatch");
    if (statEl) statEl.textContent = "0";
 
    const statusEl = document.getElementById("prefsStatus");
    statusEl.textContent = "Session watch log cleared.";
    statusEl.className = "find-status ok";
  });
}
 
/* =========================================================
   UTILITY HELPERS
   ========================================================= */
function updateStatus(message, kind) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
}
 
function updateFindStatus(message, kind) {
  const el = document.getElementById("findStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
}
 
function setElementText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
 
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
 
function formatTime(value) {
  if (!value) return "--";
  if (typeof value === "string" && value.includes("T")) {
    return new Date(value).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return String(value).substring(0, 5);
}
 
function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "--";
  return date.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}
 
function formatDuration(minutes) {
  const m = Number(minutes);
  if (!m || isNaN(m)) return "";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}
 
function getHaltCount(route) {
  if (!Array.isArray(route)) return 0;
  return route.filter((s) => s.isHalt === true).length;
}
 
/* =========================================================
   INIT
   ========================================================= */
document.addEventListener("DOMContentLoaded", () => {
  initNav();
  initStationField("from");
  initStationField("to");
  initSwapButton();
  initFareToggle();
  initOperationsFareChecker();
  initPreferencesForm();
  initSavedRoutesForm();
  initOperatorLogin();
  initIncidentAiPrediction();
  initStationTypeahead("incidentStation", "incidentStationSuggestions");
  initStationTypeahead("incidentTowards", "incidentTowardsSuggestions");
  initIncidentSpeedLimitToggle();
  initIncidentForm();
  renderIncidents();
 
  document.getElementById("findBtn").addEventListener("click", findTrains);
  document.getElementById("trackBtn").addEventListener("click", trackTrain);
 
  const trainInput = document.getElementById("trainNumber");
  if (trainInput) {
    trainInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") trackTrain();
    });
  }
 
  ["fromStation", "toStation"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") findTrains();
    });
  });
 
  const today = new Date().toISOString().slice(0, 10);
  ["travelDate", "fareDate", "opsDate"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = today;
  });
 
  renderSavedRoutes();
  renderWatchLog();
  renderOverviewRecent();
  updateSelectedServiceStat();
  checkConnection();
  loadNetworkStats();
});