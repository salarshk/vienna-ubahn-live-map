# Operational model training

`scripts/ml/train_operational_models.mjs` runs beside the U-Bahn delay
trainer. It writes `data/ml/operational-models.json`; the workflow publishes
that file as `public/ml/operational-models.json`, which is consumed by the
Prediction Lab training registry. `scripts/ml/validate_operational_models.mjs`
then adds a chronological, newest-day holdout report to the same registry and
publishes the standalone `public/ml/operational-validation.json` copy.

The registry covers the 17 experimental outputs:

- `candidate` means the archive contains a usable target and the model can be
  fitted/evaluated in the next training stage;
- `collecting-labels` means the model has a declared target, but the current
  archive is missing enough repeated outcomes to validate it;
- `blocked` means the required upstream feed is not available (currently the
  S-Bahn live vehicle/delay feed).

Six candidates also carry `production.stage = monitored-production`: multi-
horizon delay, probabilistic delay bands, route reliability, headway/bunching,
predictive anomaly detection and weather impact. This is a guarded app
promotion, not a claim that each is a fully trained causal model. Their cards
show evidence and confidence, use the shared Worker when available, and fall
back to the browser's transparent estimate when a source is missing. The
chronological holdout and model-monitoring reports continue independently.

The report deliberately keeps these states separate from the transparent
baseline cards. A card can show a useful live estimate while its learned model
is still collecting labels. A candidate is not promoted to the map until a
chronological holdout beats the corresponding live-data baseline.

The U-Bahn workflow restores the durable archive, collects the latest snapshot,
trains the delay model, refreshes this registry, and publishes both reports.
The registry is also saved with the rolling artifact so a short GitHub Actions
retention window does not erase its evidence.

The Worker writes compact rail summaries each minute and fuller observation
snapshots every five minutes under the R2 `worker-snapshots/` prefix. A separate
five-minute job archives bike observations. GitHub Actions runs the heavier
collection/training job once per day, archiving newly collected labels before
training and saving dated model reports afterward. The Worker feed proxy
avoids intermittent direct-runner HTTP 403 responses from Wiener Linien.

The daily job also archives Open-Meteo hourly weather rows and joins them to
official delay observations. When Wiener Linien omits a vehicle ID, repeated
line/direction/destination/planned-time observations provide a clearly marked
synthetic journey key for ETA opportunities; it is not treated as official
vehicle identity. Gap, station-hour pressure, incident overlap, and transfer
opportunity rows are retained as proxies, while the registry continues to say
when actual cancellation, passenger-count, attendance, or passenger-outcome
labels are still missing.
