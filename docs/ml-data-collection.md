# Transit data collection

The Wiener Linien collector runs every five minutes in GitHub Actions. It now
stores full-station U-Bahn observations with platform, route-direction,
vehicle, feed-age and incident features. It also archives the current
`trafficInfoList` and `newsList` payloads under `data/ml/raw/`.

Station-level gap and bunching lifecycles are written to
`data/ml/headway-events/YYYY-MM-DD.jsonl`. Each record contains the event type,
station, direction, interval, active duration and (after two missing polls) a
recovery duration. The browser keeps a smaller 30-day local copy as well.

The public Wiener Linien monitor is a departure-prediction feed rather than a
vehicle-GPS feed. Every headway and position record therefore includes
`positionSource` and `exactGpsAvailable`. Coordinates are saved only if the
upstream payload actually supplies them; the current feed normally produces
`exactGpsAvailable: false` instead of inventing GPS coordinates.
The collector also writes `positionConfidence`, which lets models down-weight
stale or inferred positions without presenting them as exact GPS fixes.

The collector retries temporary Wiener Linien failures with exponential
backoff, honours `Retry-After`, continues with healthy station batches, and
writes `data/ml/collection-health.json`. Each GitHub Actions run exposes that
report in its run summary, including whether the R2 archive step succeeded.

The ÖBB MMTIS portal requires accepting its terms before it reveals the ZIP
download URLs. Once those URLs are available, run:

```sh
OEBB_ZUGFAHRTEN_URL="<accepted Zugfahrten ZIP URL>" \
OEBB_NETEX_URL="<accepted NETEX ZIP URL>" \
npm run ml:oebb
```

The importer keeps the original ZIP, extracts it, writes a manifest, and
normalises CSV train-run rows to `zugfahrten.normalized.jsonl`. It is safe to
run with only one of the two URLs. If neither URL is set, it exits without
changing data and prints the official source page:

<https://data.oebb.at/de/datensaetze~datenbereitstellung_delegierte_verordnung_eu_2024-490~>

ÖBB data must be archived by date because the public Zugfahrten resource is
updated at least weekly and the public page does not promise an unlimited
historical archive.

The repository also includes a separate weekly GitHub Actions workflow,
`.github/workflows/collect-oebb-data.yml`, so the large ÖBB ZIPs are not
downloaded on every five-minute U-Bahn collection run.

## Durable archive (two-level storage)

GitHub Actions artifacts are intentionally kept as a short-lived recovery
layer for seven days. The workflows also support a durable Cloudflare R2
archive through the S3-compatible API. R2 is append-only for dated
partitions, while the rolling U-Bahn dataset is restored before training so a
temporary artifact expiry does not reset the model history.

Add these repository secrets before enabling the durable archive:

- `R2_ACCOUNT_ID`
- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The R2 access key should be scoped to the selected bucket with object read and
write permissions. If the secrets are absent, the workflows continue using the
short-lived GitHub artifact fallback and print a clear skip message.
Successful uploads also publish `health/ubahn.json` and `health/oebb.json`, so
the archive itself records its last successful write. Browser-side snapshots,
headway events, and disruption history use IndexedDB for the full local archive
while retaining only a small localStorage startup cache.
