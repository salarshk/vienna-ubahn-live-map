# U-Bahn delay model

## What is collected

The scheduled GitHub workflow samples 32 geographically distributed U-Bahn
reference stations every ten minutes. It retains only departures within 15
minutes of their current real-time estimate. Each observation contains:

- station, line, direction and destination;
- observation, planned and Wiener Linien real-time timestamps;
- the reported schedule deviation and prediction lead time;
- the published traffic-jam, accessibility and real-time-support flags;
- active incident count, highest incident priority and whether an active
  incident is delay-related.

The raw 30-day rolling dataset is stored as a GitHub Actions artifact. It is
not bundled into the public website or committed to the repository. The source
is the [Wiener Linien Open Data real-time feed](https://www.wienerlinien.at/web/guest/open-data),
published under CC BY.

The workflow also imports Wiener Linien's official historical incident export.
Its successive `firstSeen`/`lastSeen` states are compacted into U-Bahn incident
episodes. They are joined to departure observations only when line and time
genuinely overlap. The collector separately captures current incident context
with every new snapshot, so future training rows do not depend on the archive
being updated continuously. The incident export is contextual data—not a
substitute for missing historical `timeReal` labels.

## Target and leakage control

The label is the last `timeReal - timePlanned` value seen within two minutes of
departure. An observation between four and fifteen minutes earlier supplies the
features. A station-departure event is therefore never its own label and input
at the same time.

The first preliminary result requires at least 36 hours spanning two calendar
days, 150 labelled events and 30 test events. It is explicitly labelled
preliminary. Automatic promotion to validated status requires at least 144
hours spanning seven calendar days, 500 labelled events and 100 test events.
Complete later calendar days—the newest 20 percent—form the test set. They are
not used for fitting, feature scaling or model selection.

This label is the operator's final reported deviation, not independent GPS
ground truth. The distinction is displayed next to the metrics in the app.

## Fast online calibration

The online calibrator runs alongside rather than replacing the ridge model. It
starts from Wiener Linien's early delay estimate and learns small, shrunk
residual corrections for the network, line and current incident context.

Evaluation is prequential. Each journey is predicted while its final value is
still unavailable. Once that value arrives, the frozen prediction is scored;
only afterward may its error update the calibrator for later predictions.
Overlapping journeys are handled by their actual feature and label observation
times, so a future label cannot leak into an earlier prediction.

Early experimental metrics appear after 30 completed journeys. The adjustment
is used on the live map only if its prequential MAE beats the unadjusted
Wiener Linien estimate. This quick score is not called validated and does not
change the separate two-day/seven-day ridge-model promotion policy.

## Model and metrics

The first model is ridge regression over the early reported delay, prediction
lead, cyclical time/day features, traffic state, direction and line. The public
report includes:

- mean absolute error (MAE) and root mean squared error (RMSE);
- R² and percentages within one and two minutes;
- accuracy, precision, recall and F1 for delays of at least three minutes;
- the same regression metrics for the carry-forward live-estimate baseline.

The trained model is used for live predictions only when its held-out MAE beats
that baseline. Otherwise the result remains visible as an evaluated candidate,
with an explicit holdback notice.

## Reproduce locally

Run `npm run ml:incidents` once to import the official incident history, then
run `npm run ml:collect` repeatedly over time followed by `npm run ml:train`.
Observation files are deliberately ignored by Git. Compact model and metric
reports are written to `public/ml/`.
