"""
app.py
------
Minimal FastAPI service exposing the trained delay-prediction model.

Endpoint contract is written to match what the RailETA frontend already
expects from src/services/api.js -> getTrainPrediction(id), so the
frontend's `prediction` object shape needs no changes: only the values
now come from a real trained model instead of hand-written mock numbers.

Run locally with:
    uvicorn app:app --reload --port 8000

Then in the frontend, set VITE_API_BASE_URL=http://localhost:8000 and
swap the relevant function bodies in src/services/api.js to fetch from
this service (see integration notes in README.md).
"""

from datetime import datetime, timedelta

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

MODEL_PATH = "delay_model.joblib"

app = FastAPI(title="RailETA Delay Prediction Service", version="0.1.0")

# Allow the Trackline frontend to call this service directly from the
# browser. This is a local prototype (no auth/cookies involved), so a
# permissive origin list is fine here -- lock this down before any real
# deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_bundle = joblib.load(MODEL_PATH)
_pipeline = _bundle["pipeline"]
_lower_pipeline = _bundle["lower_pipeline"]
_upper_pipeline = _bundle["upper_pipeline"]
_residual_std = _bundle["residual_std"]
_station_index_table: pd.Series = _bundle["station_index_table"]
_global_mean_delay: float = _bundle["global_mean_delay"]


def infer_train_category(train_number: int) -> str:
    """Must stay identical to prepare_data.py's version."""
    if 12000 <= train_number <= 12999:
        return "superfast"
    if 13000 <= train_number <= 19999:
        return "express"
    if 50000 <= train_number <= 59999:
        return "passenger"
    if 20000 <= train_number <= 20999:
        return "vande_bharat_or_premium"
    return "other"


def station_delay_index(station_code: str | None) -> float:
    if not station_code or station_code not in _station_index_table.index:
        return _global_mean_delay
    return float(_station_index_table.loc[station_code])


class PredictionRequest(BaseModel):
    train_number: int = Field(..., description="e.g. 12638")
    journey_progress: float = Field(
        ..., ge=0, le=1, description="0 = origin, 1 = destination"
    )
    current_station_code: str | None = Field(
        None, description="Used to look up station-level congestion history"
    )
    scheduled_arrival: str = Field(
        ..., description="Scheduled arrival time as 'HH:MM' (24h)"
    )
    current_delay_min: float = Field(0, description="Delay already accrued so far")


class PredictionResponse(BaseModel):
    predictedArrival: str
    confidence: int
    rangeStart: str
    rangeEnd: str
    additionalImpactMin: float
    additionalImpactLowerMin: float
    additionalImpactUpperMin: float
    reasons: list[str]


def _add_minutes(time_str: str, minutes: float) -> str:
    base = datetime.strptime(time_str, "%H:%M")
    result = base + timedelta(minutes=minutes)
    return result.strftime("%H:%M")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/trains/{train_id}/prediction", response_model=PredictionResponse)
def predict_delay(train_id: str, req: PredictionRequest):
    if str(req.train_number) != train_id:
        raise HTTPException(400, "train_id path param must match train_number in body")

    category = infer_train_category(req.train_number)
    station_idx = station_delay_index(req.current_station_code)

    features = pd.DataFrame(
        [{
            "journey_progress": req.journey_progress,
            "station_delay_index": station_idx,
            "train_category": category,
        }]
    )

    predicted_total_delay = float(_pipeline.predict(features)[0])
    lower_bound = float(_lower_pipeline.predict(features)[0])
    upper_bound = float(_upper_pipeline.predict(features)[0])

    # Model predicts *total accumulated delay* at this point in the
    # journey; the "additional impact" the UI shows is on top of the
    # delay already known/observed, so we don't double count it.
    additional_impact = max(0.0, predicted_total_delay - req.current_delay_min)
    additional_impact_lower = max(0.0, lower_bound - req.current_delay_min)
    additional_impact_upper = max(0.0, upper_bound - req.current_delay_min)
    if additional_impact_upper < additional_impact_lower:
        additional_impact_lower, additional_impact_upper = additional_impact_upper, additional_impact_lower

    interval_width = max(upper_bound - lower_bound, 1.0)
    # Narrower interval relative to the prediction => higher confidence.
    # Clamped to a believable range for a prototype.
    confidence = int(max(55, min(92, 100 - interval_width)))

    predicted_arrival = _add_minutes(req.scheduled_arrival, predicted_total_delay)
    range_start = _add_minutes(req.scheduled_arrival, max(lower_bound, req.current_delay_min))
    range_end = _add_minutes(req.scheduled_arrival, upper_bound)

    reasons = [
        f"Current delay of {req.current_delay_min:.0f} minutes carried forward",
        f"Historical behaviour for {category} trains at this journey stage",
        f"Section congestion near {req.current_station_code or 'this point'} factored in",
    ]

    return PredictionResponse(
        predictedArrival=predicted_arrival,
        confidence=confidence,
        rangeStart=range_start,
        rangeEnd=range_end,
        additionalImpactMin=round(additional_impact, 1),
        additionalImpactLowerMin=round(additional_impact_lower, 1),
        additionalImpactUpperMin=round(additional_impact_upper, 1),
        reasons=reasons,
    )
