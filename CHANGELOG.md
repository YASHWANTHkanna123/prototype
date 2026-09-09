# Changelog — v5 update

## 0. Every remaining stop now gets its own independent ML prediction

**Before:** only the *next* stop got a real `ml-service` call each
refresh; every stop after that just displayed the same delay number
broadcast onto it.

**Change:** `fetchAndRenderEtaPrediction` still fires the one call for
the immediate next stop exactly as before (feeds the "Predicted ETA"
card, incident-combination logic, etc. — unchanged). Once that
resolves, the new `fetchAndRenderPerStopPredictions()` fires one
additional `ml-service` call *per remaining stop*, in parallel via
`Promise.allSettled`, reusing the next-stop's already-fetched result
for its own row instead of re-requesting it. As each stop's own
prediction resolves, `applyPerStopPrediction()` quietly upgrades just
that row from the shared broadcast estimate to its own number (shown
in green, marked "· AI") — same "refine in place, never blank"
pattern used elsewhere, just applied per-row.

Guarded against stale batches with the existing `mlRequestSeq`
counter (already bumped once per refresh at the top of
`fetchAndRenderEtaPrediction`, including on early-return paths), so a
slow response from an old refresh can never write into a newer one's
rows. A failed call for one stop only leaves that row on its broadcast
estimate — it doesn't affect any other stop's call.

Purely additive to the frontend only: nothing in `railradar.py`,
`app.py`, or the RailRadar API key/quota is touched — every extra
request goes to the local `ml-service` only. Tradeoff: N parallel
local calls per refresh (N = stops remaining) instead of 1; fine for
local FastAPI compute, worth knowing for very long routes.

# Changelog — v4 update

Four things fixed, all in `Trackline-frontend/` only (nothing in the
three backend services changed — none of these were server-side bugs).

## 1. "Predict Impact (AI)" filed duplicate reports for the same train

**Cause:** the submit handler always pushed a brand-new report onto
`incidentReports`, with no check for whether the logged-in operator
already had one open for that train number. "Add info" (on an
existing report) always updated correctly — only the *initial*
"Predict Impact (AI)" button was the problem, e.g. re-clicking it
after tweaking a field created a second near-identical entry instead
of updating the first.

**Fix:** before creating a report, it now looks for an existing report
by (this operator + this train number). If one exists, it's updated
in place (same fields, a new history entry, `updatedAt` bumped) —
exactly like "Add info" already does. Only files a new report if none
existed yet for that train.

## 2. Reported incident's abnormal delay wasn't showing in Live Tracking

Two separate bugs were compounding here (both visible in your
screenshots — train 22671 at Sholavandan, 96.9% progress):

**Bug A — "Next stop" / ETA target came back empty.** The code found
the next stop with a strict `route.find(s => s.sequence === current.sequence + 1)`
against the halts-only station list. That only works when the train's
*current* position is itself one of the listed halts. Sholavandan
isn't a scheduled stop on this train's route — it's a through-station
between Dindigul Jn and Madurai Jn — so its sequence number doesn't
line up with the next halt's, and the strict match found nothing. With
no target, the ML model had no scheduled-arrival time to work from, so
it fell into the "No ETA delay predicted" branch and wiped the
in-memory ETA state.

Checked RailRadar's actual API docs (`/v1/trains/{number}/live`) to
confirm: the response already includes an authoritative `nextHalt`
field (`{stationCode, stationName, sequence, distance}`) — the app
just wasn't using it. Fixed: `findNextHaltStation()` now prefers
`nextHalt`, matched back into the route list to pick up its full
schedule data, falling back to a "first halt with a sequence *after*
the current position" search (not requiring an exact match) if
`nextHalt` is ever missing.

**Bug B — the abnormal-delay card required a successful ML ETA
prediction to exist before it would show anything**, even though the
whole point of that card is to show a filed incident report. So
whenever bug A caused the ETA prediction to fail (or a train is simply
too close to its last stop, or a route genuinely lacks schedule data),
a real filed report for that train had no way to appear at all.

Fixed: `renderAbnormalDelayForTrackedTrain()` now falls back to
whatever train number is currently tracked (not just the one the ML
prediction happened to resolve for), and shows the reported incident's
delay range on its own — with a "ETA base not available yet" note in
place of the combined arrival window — instead of requiring both
pieces to succeed before showing anything.

## 3. Speed and Next stop showing "—" in Live Tracking

**Cause:** simple field-name mismatch. RailRadar's live response uses
`currentLocation.speedKmh` — the frontend was checking `speedKmph`
(with a trailing "p"), which doesn't exist in the response, so it
always fell through to "—". "Next stop" was empty for the same reason
as Bug A above.

**Fix:** speed now reads `speedKmh` first (kept the old key names as
harmless fallbacks in case a future API revision changes it again).
Next stop now uses the same `nextHalt`-first lookup as the ETA target,
so it's wired straight from the API field RailRadar actually provides.

## 4. Scheduled route table — added a predicted-ETA column, and no
   prediction shown before a train has actually departed

- Added an **"ETA (predicted)"** column to the Scheduled route table.
  Each row starts at its own scheduled time, then gets refined in
  place the same way the journey timeline already was: first with
  RailRadar's live delay, then with the ML model's predicted impact
  once that resolves. Already-passed stops just show their scheduled
  time (no speculative delay projection on something that's already
  happened).
- **New rule, applied everywhere a delay/ETA prediction is shown**
  (the ETA card, the new route-table column, and the journey
  timeline): if a train is still sitting at its *originating* station
  and its own scheduled departure time hasn't arrived yet, no
  delay/ETA prediction is shown for it — it's simply not due to leave
  yet, not "running late." Your example: scheduled to start at 3pm,
  it's 2:30pm and the train is resting at origin — no delay prediction
  should appear, and now it won't.
  - If the scheduled departure time *has* passed and the train still
    hasn't left, that's a real delay and predictions are shown as
    normal — this only suppresses the case where it's simply too
    early, not genuine lateness.
  - Implemented via a new `hasTrainStarted()` check in
    `script.js`, based on RailRadar's own `currentLocation.status`
    and the origin halt's scheduled departure time — no guessing at
    undocumented status strings.

---

# Changelog — v3 update

Five changes requested, all implemented. Two notes up front:

- I didn't receive the images referenced for points 2 and 3 (only the
  zip came through) — I built reasonable, working designs for both and
  flagged my assumptions below. Happy to adjust once you can share
  them.
- **Point 5 turned out to already work** in the package you sent me —
  see that section below for why no new code was needed there.

---

## 1. ETA "no delay" message

**Before:** *"No ETA delay predicted — train appears to be on
schedule."*
**Now:** *"No ETA delay predicted."*

`Trackline-frontend/script.js` — one line changed.

## 2. "Reinforcement / help arrived?" field

Added to **both** the initial "Predict Impact (AI)" report form and
the "Add info" recalculation form on an existing report — Yes / No /
Soon.

- `incident-service/app.py`: new `help_arrived` field. Multiplies the
  predicted delay range: **arrived** → ×0.5, **soon** → ×0.75, **no**
  → ×1.0 (unchanged, same as before this field existed). Also adds to
  confidence (+5 when stated) and appears in the reasons list.
- Updating a report's help-arrived status (or anything else) through
  "Add info" **recalculates immediately** and pushes the new number
  everywhere that report's train is shown — Track Train's abnormal-delay
  card, the total-delay chip, and Operator Mode's combined window —
  since all of those already re-render off the same shared
  `incidentPredictionsByTrain` map your existing code maintains.

**My assumption** (no image provided): I put this as a third dropdown
alongside severity/movement, in both forms, with matching styling. If
your photo showed a different layout (e.g. a toggle instead of a
dropdown, or a different position in the form), let me know and I'll
adjust — the underlying logic won't need to change, just the markup.

## 3. All Trains search results — inline delay chips

Each result row now shows, below the train name:
- **ETA delay chip** (violet) — fetched from `ml-service` per listed
  train, using the search's known origin/destination/arrival time as
  a best-effort input (these trains aren't being live-tracked yet, so
  this is rougher than the ETA card in Live Tracking — reads "ETA
  delay: not enough data" if a train has no arrival time to work
  from).
- **Abnormal delay chip** (red) — only appears if a report already
  exists for that train number (from `incidentPredictionsByTrain`,
  no extra API call needed since it's already known client-side).

Implemented in `renderResults()` / new `enhanceResultRowsWithPredictions()`
in `script.js`. Requests fire in parallel after the list renders, each
chip fills in as its own request resolves (not blocking the list).

**My assumption** (no image provided): compact pill-style chips
directly under the existing "+X min late / On time" line, not a
separate column — kept it small per your "doesn't have to be big"
note. If your photo showed something more prominent (e.g. its own
column), let me know.

## 4. Total predicted delay (ETA + incident, added together)

- `ml-service/app.py`: now also returns `additionalImpactLowerMin`
  and `additionalImpactUpperMin` (the actual range in minutes, not
  just the single-point `additionalImpactMin` it already had) — a
  pure addition, nothing existing changed shape.
- New chip — *"Total predicted delay (ETA + incident)"* — added in
  three places, all driven by one shared `computeTotalDelayRange()` /
  `renderTotalDelayRange()` pair in `script.js`:
  1. **Track Train** → ETA card
  2. **Operator Mode** → combined-window card
  3. **Journey Timeline** → header
- Shows ETA range alone if no incident is reported for that train;
  adds the incident range in the moment one exists. Updates
  automatically any time either number changes (new prediction,
  recalculated report, etc.) — no manual refresh needed.

## 5. Dynamic ETA updates as the train moves — already working

Checked this before writing new code: your package already polls
`loadTrain()` every `prefs.refreshSeconds` (default **45s**, minimum
**15s**, configurable in Preferences), and each poll already
re-fetches the ETA prediction and re-renders the combined window,
abnormal-delay card, and (now) the total-delay chip. So this was
already satisfied — I didn't touch it, since a default of 30–45s is a
reasonable balance between feeling "live" and not hammering the ML
service with requests. If you'd like it faster (e.g. every 15–20s),
just lower the value in Preferences — no code change needed.
