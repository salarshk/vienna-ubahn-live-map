# Operational model training

`scripts/ml/train_operational_models.mjs` runs beside the U-Bahn delay
trainer. It writes `public/ml/operational-models.json`, which is consumed by
the Prediction Lab training registry.

The registry covers the 17 experimental outputs:

- `candidate` means the archive contains a usable target and the model can be
  fitted/evaluated in the next training stage;
- `collecting-labels` means the model has a declared target, but the current
  archive is missing enough repeated outcomes to validate it;
- `blocked` means the required upstream feed is not available (currently the
  S-Bahn live vehicle/delay feed).

The report deliberately keeps these states separate from the transparent
baseline cards. A card can show a useful live estimate while its learned model
is still collecting labels. A candidate is not promoted to the map until a
chronological holdout beats the corresponding live-data baseline.

The U-Bahn workflow restores the durable archive, collects the latest snapshot,
trains the delay model, refreshes this registry, and publishes both reports.
The registry is also saved with the rolling artifact so a short GitHub Actions
retention window does not erase its evidence.
