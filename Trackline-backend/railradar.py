"""
railradar.py
------------
Thin client around the RailRadar API (https://railradar.in/docs).

Responsibilities:
  * Attach the Bearer token to every request.
  * Normalize network / upstream errors into the same
    {"success": False, "error": {...}} envelope RailRadar itself uses,
    so the frontend only ever has to check `result.success`.
  * Cache GET responses briefly in memory. RailRadar's free sandbox tier
    is capped at 1,000 requests/month, and this app can easily burn
    through that with auto-refreshing live views and fast typing in the
    search boxes -- a tiny in-memory TTL cache buys a lot of headroom
    without needing any external database (RailRadar already *is* the
    database of trains/stations -- we don't maintain our own copy of it).

Everything the frontend shows -- train numbers, names, timetables,
stations, fares -- comes straight from RailRadar's live catalogue. There
is no hardcoded/sample train list anywhere in this file; if RailRadar
knows about a train, Trackline can show it.
"""

import os
import time
import threading
from typing import Any, Dict, Optional

import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("RAILRADAR_API_KEY", "")
BASE_URL = "https://api.railradar.in/v1"
REQUEST_TIMEOUT = 12  # seconds

_session = requests.Session()
_session.headers.update(
    {
        "Authorization": f"Bearer {API_KEY}",
        "Accept": "application/json",
    }
)

# ---------------------------------------------------------------------------
# Tiny in-memory TTL cache
# ---------------------------------------------------------------------------
_cache_lock = threading.Lock()
_cache: Dict[str, Dict[str, Any]] = {}


def _cache_key(path: str, params: Dict[str, Any]) -> str:
    items = sorted((k, str(v)) for k, v in params.items() if v is not None)
    return path + "?" + "&".join(f"{k}={v}" for k, v in items)


def _cache_get(key: str) -> Optional[Any]:
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        if time.time() > entry["expires"]:
            _cache.pop(key, None)
            return None
        return entry["data"]


def _cache_set(key: str, data: Any, ttl: int) -> None:
    with _cache_lock:
        _cache[key] = {"data": data, "expires": time.time() + ttl}


def _error_envelope(code: str, message: str) -> Dict[str, Any]:
    return {
        "success": False,
        "error": {"code": code, "message": message},
        "meta": {"source": "backend"},
    }


def _request(path: str, params: Optional[Dict[str, Any]] = None, ttl: int = 0) -> Dict[str, Any]:
    """GET a RailRadar endpoint, with optional caching. Always returns the
    RailRadar-style envelope dict (never raises)."""
    params = params or {}

    if not API_KEY:
        return _error_envelope(
            "MISSING_API_KEY",
            "RAILRADAR_API_KEY is not set on the server. Add it to backend/.env",
        )

    key = _cache_key(path, params)
    if ttl > 0:
        cached = _cache_get(key)
        if cached is not None:
            return cached

    url = f"{BASE_URL}{path}"
    try:
        response = _session.get(url, params=params, timeout=REQUEST_TIMEOUT)
    except requests.exceptions.Timeout:
        return _error_envelope("UPSTREAM_TIMEOUT", "RailRadar API timed out. Please try again.")
    except requests.exceptions.RequestException as exc:
        return _error_envelope("NETWORK_ERROR", f"Could not reach RailRadar API: {exc}")

    # Try to parse JSON regardless of status code -- RailRadar returns a
    # structured error envelope even on 4xx/5xx.
    try:
        data = response.json()
    except ValueError:
        data = None

    if response.status_code == 200 and isinstance(data, dict):
        if ttl > 0 and data.get("success"):
            _cache_set(key, data, ttl)
        return data

    if isinstance(data, dict) and "error" in data:
        return data

    status_messages = {
        400: "Invalid request. Please check the train number / station codes.",
        401: "Invalid or missing RailRadar API key.",
        404: "Not found. Double-check the train number or station code.",
        429: "RailRadar rate limit reached (free tier: 1,000 requests/month).",
        503: "RailRadar upstream is temporarily unavailable. Please try again shortly.",
    }
    return _error_envelope(
        f"HTTP_{response.status_code}",
        status_messages.get(response.status_code, f"RailRadar API returned status {response.status_code}."),
    )


# ---------------------------------------------------------------------------
# Public functions used by app.py
# ---------------------------------------------------------------------------
def get_train_live_status(
    train_number: str,
    date: Optional[str] = None,
    authoritative: bool = False,
    halts_only: bool = False,
) -> Dict[str, Any]:
    """Live position, delay, and full route for a single train."""
    params = {
        "date": date,
        "authoritative": "true" if authoritative else None,
        "haltsOnly": "true" if halts_only else "false",
        "includeCoordinates": "true",
    }
    # Live data should feel fresh -- short cache just to protect against
    # rapid duplicate calls (e.g. component re-renders), not to go stale.
    return _request(f"/trains/{train_number}/live", params, ttl=15)


def get_trains_between(
    from_station: str,
    to_station: str,
    date: Optional[str] = None,
    train_type: Optional[str] = None,
    category: Optional[str] = None,
    by_city: bool = False,
    live: bool = True,
) -> Dict[str, Any]:
    """All direct trains between two station codes. One call returns the
    whole results list -- no per-row fare/class calls are made here."""
    params = {
        "date": date,
        "type": train_type,
        "category": category,
        "byCity": "true" if by_city else None,
        "live": "true" if live else "false",
    }
    from_code = from_station.strip().upper()
    to_code = to_station.strip().upper()
    # Timetable data is stable across a day; cache a bit longer. If `live`
    # enrichment was requested we still cache briefly (short window) so a
    # user re-searching the same route doesn't burn extra quota.
    ttl = 20 if live else 120
    return _request(f"/trains/between/{from_code}/{to_code}", params, ttl=ttl)


def search_stations(query: str, limit: int = 10) -> Dict[str, Any]:
    """Autocomplete search across station codes / names."""
    params = {"q": query, "limit": limit}
    return _request("/lookup/search/stations", params, ttl=300)


def get_train_fare(
    train_number: str,
    from_station: str,
    to_station: str,
    date: Optional[str] = None,
    quota: Optional[str] = None,
) -> Dict[str, Any]:
    """Class-wise fare & availability for one train on one journey leg.

    This is deliberately its own call, kept OFF the results list. It is
    only ever invoked once a user selects a specific train from `All
    Trains`, or from the Operations fare checker -- never once-per-row --
    to stay well inside RailRadar's free-tier quota.
    """
    params = {
        "fromStationCode": from_station.strip().upper(),
        "toStationCode": to_station.strip().upper(),
        "date": date,
        "quota": quota,
    }
    # Fares move slowly (dynamic/premium pricing aside); cache a few
    # minutes so re-opening the same train doesn't cost another call.
    return _request(f"/trains/{train_number}/fare", params, ttl=600)


# ---------------------------------------------------------------------------
# Network-wide snapshot, for the Overview dashboard's stat cards
# ---------------------------------------------------------------------------
# This is fetched ONCE and cached for hours (not per page load, and not
# per user) -- it backs the "Trains indexed" / "Network reach" stat cards.
#
# NOTE on the endpoint: the three endpoints Trackline was built around
# (`/trains/{number}/live`, `/trains/between/...`, `/lookup/search/stations`)
# are all RailRadar gives per-train/per-route data, not a documented bulk
# "list everything" endpoint. We ask RailRadar's train lookup for a single
# page and read the network-wide totals out of its `meta` block, which is
# the common REST-list convention RailRadar follows elsewhere. If your
# RailRadar plan exposes a dedicated stats/index endpoint, swap the path
# below (`_STATS_PATH`) for that -- everything else (caching, shape) stays
# the same.
_STATS_PATH = "/trains"
_stats_lock = threading.Lock()
_stats_state: Dict[str, Any] = {"data": None, "expires": 0}

_STATS_TTL_OK = 6 * 60 * 60   # 6 hours -- this number barely moves.
_STATS_TTL_FAIL = 10 * 60     # back off 10 min on failure so a missing/renamed
                               # endpoint can't be hammered every page load.


def get_network_stats() -> Dict[str, Any]:
    """Bulk, cached-once snapshot of how much of the network RailRadar
    covers. Never called per page load -- callers should hit the backend's
    own `/meta/network-stats` route, which itself only ever calls
    RailRadar again after the cache below expires."""
    now = time.time()
    with _stats_lock:
        cached = _stats_state["data"]
        if cached is not None and now < _stats_state["expires"]:
            return cached

    result = _request(_STATS_PATH, {"limit": 1}, ttl=0)  # own cache below

    if result.get("success"):
        meta = result.get("meta") or {}
        data = result.get("data")
        total_trains = meta.get("totalTrains") or meta.get("total") or meta.get("totalCount")
        if total_trains is None and isinstance(data, list):
            total_trains = None  # a single-page sample can't tell us the total
        stats = {
            "success": True,
            "totalTrains": total_trains,
            "totalStations": meta.get("totalStations"),
            "generatedAt": time.time(),
        }
        ttl = _STATS_TTL_OK if total_trains is not None else _STATS_TTL_FAIL
    else:
        stats = {
            "success": False,
            "error": result.get("error"),
            "generatedAt": time.time(),
        }
        ttl = _STATS_TTL_FAIL

    with _stats_lock:
        _stats_state["data"] = stats
        _stats_state["expires"] = now + ttl
    return stats
