# Incident Impact Service (rule-based prototype)

Predicts an **additional delay range (min–max minutes)** on top of a
train's normal ETA, based on a controller-submitted incident report.
This is a **third, independent** microservice — it doesn't touch
`Trackline/backend` (RailRadar) or `ml-service` (the historical ETA
model). Runs on **port 8002** by default.

## Why this is rule-based, not a trained model

A trained model needs historical examples of
`(incident report) -> (actual delay that happened)` to learn from.
There is currently no such dataset. So instead of statistics, this
service uses an explicit lookup table — base delay range per incident
type, multiplied by severity and by how the train is currently moving.
The numbers in `INCIDENT_BASE_RANGE`, `SEVERITY_MULTIPLIER`, and
`MOVEMENT_MULTIPLIER` in `app.py` are starting estimates you should
adjust to match real operational experience.

**The response shape is intentionally identical to what a real trained
model would return** (`minDelayMin`, `maxDelayMin`, `confidence`,
`reasons`), so this file can be replaced later with a genuinely
trained model — once you start logging real incident outcomes — with
zero changes needed in the frontend.

## Confidence here means something different than in ml-service

In `ml-service`, confidence comes from a quantile-regression interval
width — a statistical measure. Here, confidence is a **report
completeness score**: a report with a specific incident type, a stated
severity, a stated movement status, and photo evidence scores higher
than a vague one. It reflects "how well-evidenced is this input", not
"how statistically likely is this prediction to be right". Be
transparent about that distinction if you present this to anyone.

## About the other .joblib file you have

You separately have a `.joblib` model bundle (two quantile-regression
pipelines) that expects **live operational telemetry** as input —
`current_speed_kmh`, `speed_delta_5min`, `delay_growth_rate`,
`track_usability`, `held_trains_count`, `diversion_available`, etc. —
not the type/severity/photo fields a controller would fill in a report
form. That's a different (and in principle more powerful) approach:
if your system ever gets a live telemetry feed per train, that model
could become a second, complementary prediction source. It's not wired
into this service because those inputs don't match your controller
report flow, and there's no visibility into what data or process it
was trained on. Keep the file — it may be useful later.

## Run it

```bash
cd incident-service
python -m venv venv          # first time only
venv\Scripts\activate        # Windows; macOS/Linux: source venv/bin/activate
pip install fastapi "uvicorn[standard]"
uvicorn app:app --reload --port 8002
```

## Test it

```bash
curl -X POST http://127.0.0.1:8002/incidents/prediction ^
  -H "Content-Type: application/json" ^
  -d "{\"incident_known\":true,\"incident_type\":\"signal_failure\",\"severity\":\"major\",\"movement_status\":\"stopped\",\"has_photo\":true}"
```

Expected response shape:
```json
{
  "incidentKnown": true,
  "minDelayMin": 22.5,
  "maxDelayMin": 78.8,
  "confidence": 85,
  "reasons": ["Major severity signal/interlocking failure reported by controller.", "..."]
}
```

## Combining with the ETA prediction

The frontend calls `ml-service` for a train's predicted arrival, then
calls this service for `minDelayMin`/`maxDelayMin`, and adds them:

```
combinedArrivalMin = etaPredictedArrival + incident.minDelayMin
combinedArrivalMax = etaPredictedArrival + incident.maxDelayMin
```

This is implemented in `Trackline/frontend/script.js` in the
`combineEtaWithIncident()` function — see
`README_INCIDENT_INTEGRATION.md` in the parent folder for what changed
in the frontend.
