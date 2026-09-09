from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

import railradar

app = FastAPI(title="Trackline API", version="1.1.0")

# Allow the frontend (served from any local origin / file) to call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def home():
    return {
        "message": "Trackline Live Tracker Backend is running!",
        "endpoints": [
            "/trains/{train_number}/live",
            "/trains/{train_number}/fare?from_station=..&to_station=..",
            "/trains/between?from_station=..&to_station=..",
            "/stations/search?q=..",
            "/meta/network-stats",
        ],
    }


@app.get("/trains/{train_number}/live")
def train_live(
    train_number: str,
    date: Optional[str] = Query(None, description="YYYY-MM-DD, defaults to today's run"),
    authoritative: bool = Query(False, description="Bypass cache, force live upstream fetch"),
    halts_only: bool = Query(False, description="Only return halting stations in route[]"),
):
    return railradar.get_train_live_status(
        train_number=train_number,
        date=date,
        authoritative=authoritative,
        halts_only=halts_only,
    )


@app.get("/trains/between")
def trains_between(
    from_station: str = Query(..., min_length=2, description="Source station code, e.g. MAS"),
    to_station: str = Query(..., min_length=2, description="Destination station code, e.g. MDU"),
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    train_type: Optional[str] = Query(None, alias="type"),
    category: Optional[str] = Query(None),
    by_city: bool = Query(False, alias="byCity"),
    live: bool = Query(True, description="Enrich each train with live status at the source station"),
):
    return railradar.get_trains_between(
        from_station=from_station,
        to_station=to_station,
        date=date,
        train_type=train_type,
        category=category,
        by_city=by_city,
        live=live,
    )


@app.get("/trains/{train_number}/fare")
def train_fare(
    train_number: str,
    from_station: str = Query(..., min_length=2, description="Boarding station code"),
    to_station: str = Query(..., min_length=2, description="Alighting station code"),
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    quota: Optional[str] = Query(None, description="e.g. GN, TQ, LD"),
):
    """Class/fare/availability for one train on one leg. Only ever called
    once a specific train has been selected (see frontend script.js) --
    never in a loop over a results list."""
    return railradar.get_train_fare(
        train_number=train_number,
        from_station=from_station,
        to_station=to_station,
        date=date,
        quota=quota,
    )


@app.get("/stations/search")
def stations_search(
    q: str = Query(..., min_length=1, description="Station code or name, e.g. 'MAS' or 'Chennai'"),
    limit: int = Query(10, ge=1, le=50),
):
    return railradar.search_stations(query=q, limit=limit)


@app.get("/meta/network-stats")
def network_stats():
    """Bulk snapshot (trains indexed / stations covered) for the Overview
    dashboard. Cached server-side for hours -- see railradar.get_network_stats.
    The frontend also caches this in memory per session, so it's fetched
    once total, not once per page/panel."""
    return railradar.get_network_stats()
