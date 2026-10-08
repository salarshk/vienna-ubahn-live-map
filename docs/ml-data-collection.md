# Transit data collection

The Cloudflare Worker collects official departure observations every minute,
storing compact station summaries in R2; it archives a fuller observation
snapshot every five minutes. A daily GitHub Actions job restores a bounded
recent window, stores full-station U-Bahn training observations with platform,
route-direction, vehicle, feed-age and incident features, and archives the current
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
run with only one of the two URLs. The original CSV rows remain in the ZIP;
normalized output omits the duplicated `raw` object unless
`OEBB_INCLUDE_RAW=true` is set. If neither URL is set, it exits without
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
layer for seven days. Cloudflare R2 is the long-term record: dated rail-minute,
full Worker, bike and mobility snapshots, labelled U-Bahn partitions, ÖBB
imports when the source is available, and versioned model/validation reports.
The last 21 days of Worker snapshots are restored for each daily training run;
older dated objects remain in R2. Short rolling objects power the website.
No code-level expiry is applied to dated R2 objects; bucket lifecycle settings
can still remove them if configured separately.

Add these repository secrets before enabling the durable archive:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The workflow sets `R2_BUCKET=vienna-rail-archive`; it is not another secret.

The R2 access key should be scoped to the selected bucket with object read and
write permissions. A missing upload credential now fails the archive step
instead of silently reporting success. Successful uploads publish
`health/ubahn.json`, `health/models.json` and `health/oebb.json`. Browser-side
snapshots and preferences still use local storage for user experience, but the
shared rail/bike observations and dated model reports are not dependent on any
user keeping the app open. Official train GPS, passenger counts and licensed
traffic/event values are not created by this archive when upstream data is
unavailable.
