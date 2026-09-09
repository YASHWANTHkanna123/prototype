# Trackline + ETA Prediction + AI Incident Impact — Complete Package

Everything you need is in this one zip — 4 folders, 4 services. You do
NOT need your old `integration.zip` for anything except your RailRadar
API key, which is already carried over into `Trackline-backend/.env`
below (keep this zip private since it contains that key).

```
Trackline-backend/     RailRadar integration (unchanged from your original)      port 8000
ml-service/             Historical ETA delay model (unchanged)                    port 8001
incident-service/       NEW: rule-based abnormal-incident delay predictor         port 8002
Trackline-frontend/     UPDATED: your original UI + new AI incident report card   port 5501
```

## Run order — open 4 Command Prompt windows

### Terminal 1 — Trackline backend (RailRadar), port 8000
```cmd
cd path\to\complete-package\Trackline-backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```
Your API key is already in `.env` in this folder — nothing to add.

### Terminal 2 — ml-service (ETA prediction model), port 8001
```cmd
cd path\to\complete-package\ml-service
python -m venv venv
venv\Scripts\activate
pip install fastapi "uvicorn[standard]" scikit-learn==1.8.0 pandas numpy joblib
uvicorn app:app --reload --port 8001
```
**Note the pinned `scikit-learn==1.8.0`** — the model file was trained
with that version; installing the newer default (1.9.0) will crash it
with `ModuleNotFoundError: No module named '_loss'` (we hit this
before, this pin fixes it from the start).

### Terminal 3 — incident-service (NEW: AI incident impact predictor), port 8002
```cmd
cd path\to\complete-package\incident-service
python -m venv venv
venv\Scripts\activate
pip install fastapi "uvicorn[standard]"
uvicorn app:app --reload --port 8002
```

### Terminal 4 — Trackline-frontend (UPDATED UI), port 5501
```cmd
cd path\to\complete-package\Trackline-frontend
python -m http.server 5501
```

Then open **`http://127.0.0.1:5501`** in your browser. All 4 terminals
must stay running at the same time.

## What you'll see

Everything works exactly as your original app did — Overview, All
Trains, Live Tracking (with the "Predicted ETA · ML model" card),
Operations, Saved Routes, Preferences — plus, in **Operator Mode**
(log in with any dummy credentials), a new **"AI Delay Impact
Prediction"** card below your existing manual incident log:

- Yes/No: is a known incident affecting this train right now?
- If yes: incident type, severity, live movement (normal / slow /
  stopped), optional photo, optional notes
- **"Predict Impact (AI)"** → shows a predicted **min–max additional
  delay** and a confidence percentage, with reasons
- If you've already tracked a train in Live Tracking (so its ETA
  prediction has loaded), a **combined window card** appears
  automatically: `ETA predicted arrival + incident min–max delay =
  combined worst-case arrival window`

## Important: what kind of "AI" this is

The incident predictor is a **rule-based estimator**, not a trained
ML model — there's no historical dataset of real incidents and their
actual resulting delays to train on. It uses an explicit, editable
lookup table (incident type × severity × movement status → a delay
range) documented in `incident-service/README.md`, with the exact
same output shape a trained model would have — so it can be swapped
for a real trained model later with zero frontend changes, once you
have real incident-outcome data to learn from.

If this comes up in your SIH review: describe it accurately as a
rule-based expert system designed to be upgraded to a trained model
later, not as something already trained on data. That's a completely
legitimate and common approach when no labeled dataset exists yet —
just represent it correctly.

The `ml-service` ETA model **is** a real trained model (GradientBoosting,
trained on ~1,900 historical stop records — see `ml-service/README.md`
for its honest accuracy numbers).

## Testing each service directly (optional, without the UI)

```cmd
curl -X POST http://127.0.0.1:8001/trains/12658/prediction -H "Content-Type: application/json" -d "{\"train_number\":12658,\"journey_progress\":0.4,\"current_station_code\":\"AJJ\",\"scheduled_arrival\":\"14:05\",\"current_delay_min\":10}"

curl -X POST http://127.0.0.1:8002/incidents/prediction -H "Content-Type: application/json" -d "{\"incident_known\":true,\"incident_type\":\"signal_failure\",\"severity\":\"major\",\"movement_status\":\"stopped\",\"has_photo\":true}"
```

## If something breaks

Your original `integration.zip` is untouched on your PC — if anything
here doesn't work, you can always go back to running that exactly as
before. Nothing in this package modifies or depends on your old
extracted folder.

---

## Update log (v2 — this package)

**1. Live Tracking ETA card, "not enough schedule data" fixed**
Previously this message showed regardless of whether the train was actually delayed. Now:
- If RailRadar already reports a live delay for the train, that delay is shown directly (labeled as live, not ML-predicted).
- If there's no live delay, the card now says "No ETA delay predicted — train appears to be on schedule" instead of a generic error.

**2. Journey timeline train icon — positioning accuracy**
- The indicator now anchors to each station row's actual vertical midpoint (measured after layout) instead of a fixed pixel offset, so it no longer drifts out of alignment when a station name wraps onto two lines.
- When live distance data isn't available for interpolation, it now falls back to a time-based estimate (using scheduled departure/arrival vs. the current clock) instead of freezing at the last halt.

**3. Journey timeline — delay-adjusted arrival/departure times**
Every upcoming/current/next stop in the timeline now shows a projected time next to the scheduled one (e.g. `~14:15 (+10m)`), using RailRadar's live delay immediately and refining to the ML model's predicted impact once that resolves. Already-passed stops are left as-is.

**4. Operator Mode — persisted per-operator reports**
- The AI Delay Impact Prediction form now requires a **train number**, so reports are tied to a specific train.
- Reports are saved (localStorage) tagged with the logged-in operator's name.
- Logging in under the same name shows a new **"Your AI Delay Impact reports"** section (right after login) listing every report you've filed, with an **"Add info"** option per report that lets you update type/severity/movement/photo and re-submit, recalculating the delay range — the original "Predict Impact (AI)" flow for filing a brand-new report is unchanged and still present further down the page.
- Reports/incident predictions are now matched strictly by train number wherever they combine with an ETA prediction (Live Tracking's abnormal-delay card and the Operator combined-window card), so an incident for train A never gets attached to a different tracked train B.
