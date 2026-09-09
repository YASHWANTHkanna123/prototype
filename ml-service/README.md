# RailETA Delay Prediction — ML Pipeline

Trains and serves a real regression model on your Kaggle/etrain.info
dataset (`etrain_delays.csv`), and exposes it as a FastAPI service with
the exact response shape your React frontend already expects.

## What the dataset actually is

One row per (train, station): the **historical average delay** at that
station for that train, plus % on-time / slightly-delayed /
significantly-delayed / cancelled, scraped from etrain.info. Rows are
in real route order — confirmed because delay visibly accumulates with
distance travelled (e.g. train 12638 Pandian Express: 1 min at
Madurai → 23 min near Tambaram → recovers approaching Chennai Egmore).

It is **not** per-journey data (no date, no weather, no live incident
info) — so this can't predict "today's" delay for a specific run, but
it's genuinely useful for learning how delay accumulates along a route
and generalizing that pattern to trains it's never seen.

## Files

| File | Purpose |
|---|---|
| `prepare_data.py` | Cleans the raw CSV, computes `journey_progress` (0→1 along the route) and a rough `train_category` from the train number series |
| `train_model.py` | Trains a `GradientBoostingRegressor` + two quantile models (p10/p90 for the prediction interval), evaluated with `GroupKFold` so **entire trains are held out** — this measures generalization to trains never seen in training |
| `app.py` | FastAPI service: `POST /trains/{id}/prediction` returns the same JSON shape as `src/services/api.js` already expects |
| `delay_model.joblib` | The trained model bundle |

## Honest results

Evaluated on held-out trains (not held-out rows — whole trains the
model never saw at all):

- **Naive baseline** (always predict the training mean): ~31.3 min MAE
- **Trained model**: ~26.3 min MAE — a **16% improvement**

Features used: `journey_progress`, `train_category` (superfast /
express / passenger, from the train number series), and
`station_delay_index` (a station-level historical congestion average,
computed only from other trains — many trains share the same
junctions, so this transfers to unseen trains).

Deliberately **not** used: `train_number` (doesn't generalize to new
trains) and the `pct_right_time` / `pct_slight_delay` / etc. columns
(these are just another view of the same historical distribution as
the label — using them would be leakage dressed up as a feature, not
a real prediction).

**Be upfront about this number if asked**: 26 minutes of average error
is large in absolute terms — this dataset alone can only capture
"how does this category of train behave at this stage of a route,"
not day-specific or incident-specific delay. The honest pitch is:
*"this is a real, validated statistical model, and it's designed to
be one input into the ETA — combined with the live incident-impact
engine you already built, and later with day/weather/live-position
features once you have per-journey data."*

## How to run it

```bash
pip install fastapi "uvicorn[standard]" scikit-learn pandas numpy joblib
python3 prepare_data.py     # only needed if the CSV changes
python3 train_model.py      # only needed if you retrain
uvicorn app:app --reload --port 8000
```

Test it:
```bash
curl -X POST http://localhost:8000/trains/12638/prediction \
  -H "Content-Type: application/json" \
  -d '{"train_number":12638,"journey_progress":0.18,"current_station_code":"TBM","scheduled_arrival":"18:30","current_delay_min":12}'
```

## Connecting this to your existing RailETA frontend

Your `src/services/api.js` already has a placeholder
`getTrainPrediction(id)` function with a comment saying it will later
call `GET /trains/{id}/prediction`. To wire it up:

1. In your React project's `.env`:
   ```
   VITE_API_BASE_URL=http://localhost:8000
   ```

2. Replace the body of `getTrainPrediction` in `src/services/api.js`
   with a real fetch. It needs `journey_progress`, which you already
   compute implicitly via `routeProgress` + route position in
   `src/utils/simulation.js` — convert it to 0–1 across the *whole*
   route (not just the current leg) before sending:

   ```js
   export async function getTrainPrediction(id) {
     const train = getTrainById(id); // still used for scheduledArrival etc.
     const stationIndex = train.route.indexOf(train.currentStationCode);
     const journeyProgress = stationIndex / (train.route.length - 1);

     const res = await fetch(`${API_BASE_URL}/trains/${id}/prediction`, {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({
         train_number: Number(id),
         journey_progress: journeyProgress,
         current_station_code: train.currentStationCode,
         scheduled_arrival: train.scheduledArrival,
         current_delay_min: train.currentDelayMin,
       }),
     });
     if (!res.ok) throw new Error("Prediction request failed");
     return res.json();
   }
   ```

3. No component changes needed — `ETAForecast.jsx`, `TrainDetails.jsx`,
   and `computeLiveTrainPrediction()` all consume the same
   `{ predictedArrival, confidence, rangeStart, rangeEnd,
   additionalImpactMin, reasons }` shape whether it comes from mock
   data or this service.

4. Your existing incident-impact logic
   (`predictIncidentImpact`, `computeLiveTrainPrediction` in
   `src/utils/simulation.js`) stays exactly as-is and layers on top of
   whatever `getTrainPrediction` returns — real model or mock, the
   incident math doesn't care.

## Where this goes next (for judges / roadmap slide)

- Swap the CSV for a live-scraped or NTES-integrated feed to retrain
  periodically instead of a one-time snapshot.
- Add per-journey features once available: day of week, time of day,
  season, weather — this dataset structurally can't support those yet.
- Feed the incident engine's predicted impact back into the model as a
  feature instead of adding it post-hoc, once there's historical
  incident-outcome data to train on.
- Move `delay_model.joblib` load + `/trains/{id}/prediction` into the
  eventual FastAPI + PostgreSQL backend as one more route.
