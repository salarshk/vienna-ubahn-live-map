# Advanced network analytics

The Signals view adds data-derived features that are not documented as
passenger-facing WienMobil or ÖBB SCOTTY outputs. It uses public departure
predictions, official service messages, the local track graph, inferred U-Bahn
positions and the browser's short history.

## Included signals

1. ETA ranges with a confidence score rather than a single point estimate.
2. Missed-connection probability and cross-operator transfer health.
3. A heuristic line recovery window after gaps or bunching.
4. Line reliability and station anomaly hotspots.
5. Calendar-aware crowd-pressure outlooks; no occupancy is claimed.
6. Possible prolonged dwell and low-confidence direction checks.
7. Step-free impact summaries and alternatives to verify.
8. Evidence timelines for delay causes.
9. A transparent what-if propagation simulator.
10. Feed-quality confidence with stale-station counts and timetable freshness.
11. A map legend and train detail label separating official Wiener Linien
    timing from the position inferred along the track.
12. A local ten-minute official-delay archive and historical replay, distinct
    from the shorter inferred-position replay.
13. Passenger reports for crowding, blocked doors, incidents, accessibility and
    unshown delays. They are anonymous, browser-local and automatically expire.
14. A privacy-preserving occupancy proxy that combines service patterns, time of
    day, inferred vehicles and optional reports; it is not passenger counting.
15. Explainable delay-cause classification with an evidence source and confidence.
16. Model monitoring with a safe automatic rollback to the live estimate when a
    candidate is stale, invalid, too inaccurate or worse than the baseline.
17. A line-by-line Operations view showing attention status, occupancy proxy,
    reliability, reports, causes and a human-review action cue.

The estimates intentionally remain advisory. Public Wiener Linien data does
not expose signalling state, track occupation, passenger counts or GPS ground
truth for every U-Bahn train. The app therefore labels proxies, confidence and
verification needs instead of presenting inferred values as official facts.
