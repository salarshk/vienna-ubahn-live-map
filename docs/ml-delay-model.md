# U-Bahn delay model

## What is collected

The scheduled GitHub workflow samples 32 geographically distributed U-Bahn
reference stations every ten minutes. It retains only departures within 15
minutes of their current real-time estimate. Each observation contains:

- station, line, direction and destination;
- observation, planned and Wiener Linien real-time timestamps;
- the reported schedule deviation and prediction lead time;
- the published traffic-jam, accessibility and real-time-support flags.

The raw 30-day rolling dataset is stored as a GitHub Actions artifact. It is
not bundled into the public website or committed to the repository. The source
is the [Wiener Linien Open Data real-time feed](https://www.wienerlinien.at/web/guest/open-data),
published under CC BY.

## Target and leakage control

The label is the last `timeReal - timePlanned` value seen within two minutes of
departure. An observation between four and fifteen minutes earlier supplies the
features. A station-departure event is therefore never its own label and input
at the same time.

Training waits for at least seven calendar days, 500 labelled events and 100
test events. Complete later calendar days—the newest 20 percent—form the test
set. They are not used for fitting, feature scaling or model selection.

This label is the operator's final reported deviation, not independent GPS
ground truth. The distinction is displayed next to the metrics in the app.

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

Run `npm run ml:collect` repeatedly over time, followed by `npm run ml:train`.
Observation files are deliberately ignored by Git. Compact model and metric
reports are written to `public/ml/`.
