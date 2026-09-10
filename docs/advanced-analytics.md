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

The estimates intentionally remain advisory. Public Wiener Linien data does
not expose signalling state, track occupation, passenger counts or GPS ground
truth for every U-Bahn train. The app therefore labels proxies, confidence and
verification needs instead of presenting inferred values as official facts.
