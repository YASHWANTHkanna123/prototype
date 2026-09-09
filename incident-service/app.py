"""
app.py
------
Abnormal-incident delay-impact service.

IMPORTANT — READ BEFORE DEPLOYING:
This is a RULE-BASED estimator, not a trained ML model. There is no
historical dataset of (incident report -> actual resulting delay) to
learn from, so instead of statistics this uses an explicit, documented
lookup table of typical delay impact by incident type/severity/train
movement status. The output SHAPE (minDelayMin / maxDelayMin /
confidence / reasons) is deliberately identical to what a trained
model would return, so this can be swapped out for a real model later
-- once real incident-outcome data exists -- without changing the
frontend or the response contract at all.

Endpoint contract:
    POST /incidents/prediction
    -> { incidentKnown, minDelayMin, maxDelayMin, confidence, reasons }

Run locally with:
    uvicorn app:app --reload --port 8002
"""

from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="RailETA Incident Impact Service (rule-based)", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------
# RULE TABLES (edit these numbers to match your railway's real-world
# experience -- they are starting estimates, not measured statistics)
# ---------------------------------------------------------------------

# (min_delay_min, max_delay_min) at "moderate" severity, "moving slowly"
# movement, before the severity/movement multipliers below are applied.
INCIDENT_BASE_RANGE = {
    "signal_failure": (10, 35),
    "track_obstruction": (15, 55),
    "technical_fault": (20, 80),
    "medical_emergency": (10, 30),
    "ohe_power_issue": (25, 100),
    "severe_weather": (15, 60),
    "derailment": (60, 220),
    "security_issue": (20, 90),
    "level_crossing_issue": (15, 45),
    "other": (10, 45),
}

SEVERITY_MULTIPLIER = {
    "minor": 0.6,
    "moderate": 1.0,
    "major": 1.5,
    "critical": 2.2,
}

# How much extra the reported live movement status adds on top of the
# base/severity estimate -- a train fully stopped implies materially
# more delay than one still creeping forward.
MOVEMENT_MULTIPLIER = {
    "normal": 0.6,
    "slow": 1.0,
    "stopped": 1.5,
}

# Reinforcement / assistance status reported by the controller. Help
# already on-site should meaningfully shrink the predicted range;
# help "on the way" shrinks it a little less; no help leaves the
# estimate unchanged (this is the same as the old default behaviour
# before this field existed, so it's backward compatible).
HELP_ARRIVED_MULTIPLIER = {
    "yes": 0.5,
    "soon": 0.75,
    "no": 1.0,
}

INCIDENT_TYPE_LABELS = {
    "signal_failure": "signal/interlocking failure",
    "track_obstruction": "track obstruction",
    "technical_fault": "rolling stock / technical fault",
    "medical_emergency": "onboard medical emergency",
    "ohe_power_issue": "OHE power / line block",
    "severe_weather": "severe weather / waterlogging",
    "derailment": "derailment",
    "security_issue": "security / law-and-order issue",
    "level_crossing_issue": "level crossing malfunction",
    "other": "unspecified incident",
}


class IncidentReportRequest(BaseModel):
    incident_known: bool = Field(..., description="Controller confirms an incident is affecting the train")
    incident_type: Optional[str] = Field(None, description="One of INCIDENT_BASE_RANGE's keys")
    severity: Optional[str] = Field(None, description="minor | moderate | major | critical")
    movement_status: Optional[str] = Field(None, description="normal | slow | stopped")
    has_photo: bool = Field(False, description="Whether the controller attached photo evidence")
    help_arrived: Optional[str] = Field(None, description="yes | no | soon -- has reinforcement/assistance reached the train")
    notes: Optional[str] = Field(None, description="Free-text context, shown back in reasons only")


class IncidentPredictionResponse(BaseModel):
    incidentKnown: bool
    minDelayMin: float
    maxDelayMin: float
    confidence: int
    reasons: list[str]


@app.get("/health")
def health():
    return {"status": "ok", "model_type": "rule_based"}


@app.post("/incidents/prediction", response_model=IncidentPredictionResponse)
def predict_incident_impact(req: IncidentReportRequest):
    if not req.incident_known:
        return IncidentPredictionResponse(
            incidentKnown=False,
            minDelayMin=0.0,
            maxDelayMin=0.0,
            confidence=80,
            reasons=["Controller reports no known incident currently affecting this train."],
        )

    incident_type = (req.incident_type or "other").strip().lower()
    if incident_type not in INCIDENT_BASE_RANGE:
        incident_type = "other"

    severity = (req.severity or "moderate").strip().lower()
    if severity not in SEVERITY_MULTIPLIER:
        severity = "moderate"

    movement = (req.movement_status or "slow").strip().lower()
    if movement not in MOVEMENT_MULTIPLIER:
        movement = "slow"

    base_min, base_max = INCIDENT_BASE_RANGE[incident_type]
    sev_mult = SEVERITY_MULTIPLIER[severity]
    move_mult = MOVEMENT_MULTIPLIER[movement]

    help_arrived = (req.help_arrived or "no").strip().lower()
    if help_arrived not in HELP_ARRIVED_MULTIPLIER:
        help_arrived = "no"
    help_mult = HELP_ARRIVED_MULTIPLIER[help_arrived]

    # Sanity ceiling: severity (up to 2.2x) and movement (up to 1.5x)
    # multipliers can compound to over 3x on an already-large base range
    # (e.g. derailment) and produce implausible values like 700+ minutes.
    # Cap at 8 hours -- past that point "predicted delay" stops being a
    # meaningful number and it's a full disruption/replacement scenario.
    DELAY_CEILING_MIN = 480

    min_delay = round(min(base_min * sev_mult * move_mult * help_mult, DELAY_CEILING_MIN), 1)
    max_delay = round(min(base_max * sev_mult * move_mult * help_mult, DELAY_CEILING_MIN), 1)
    if max_delay < min_delay:
        min_delay, max_delay = max_delay, min_delay

    # --- confidence: how specific/well-evidenced the report is, NOT a
    # statistical accuracy measure (see module docstring). ---
    confidence = 50
    if incident_type != "other":
        confidence += 15
    else:
        confidence -= 10
    if req.severity:
        confidence += 10
    if req.movement_status:
        confidence += 10
    if req.has_photo:
        confidence += 15
    if req.help_arrived:
        confidence += 5
    confidence = max(40, min(90, confidence))

    type_label = INCIDENT_TYPE_LABELS.get(incident_type, incident_type)
    movement_label = {
        "normal": "still moving at normal speed",
        "slow": "moving slowly through the affected section",
        "stopped": "stopped / held at rest",
    }[movement]

    reasons = [
        f"{severity.title()} severity {type_label} reported by controller.",
        f"Train currently {movement_label}.",
    ]
    reasons.append(
        "Photo evidence attached, increasing confidence in the reported scale."
        if req.has_photo
        else "No photo attached — estimate relies on the controller's verbal assessment."
    )
    if req.notes:
        reasons.append(f"Controller note: {req.notes.strip()}")
    help_label = {
        "yes": "Reinforcement/assistance has already reached the train, reducing expected delay.",
        "soon": "Reinforcement/assistance is en route, modestly reducing expected delay.",
        "no": "No reinforcement/assistance reported yet.",
    }[help_arrived]
    reasons.append(help_label)
    if base_max * sev_mult * move_mult * help_mult > DELAY_CEILING_MIN:
        reasons.append(
            "Estimate capped at 8 hours — beyond this, treat it as a major "
            "disruption requiring manual replanning, not a delay estimate."
        )
    reasons.append(
        "Estimate from a rule-based lookup table (no historical incident-outcome "
        "data yet available to train a statistical model)."
    )

    return IncidentPredictionResponse(
        incidentKnown=True,
        minDelayMin=min_delay,
        maxDelayMin=max_delay,
        confidence=confidence,
        reasons=reasons,
    )
