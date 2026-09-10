# Vienna U-Bahn & S-Bahn Map

**Website:** <https://salarshk.github.io/vienna-ubahn-live-map/>

An interactive map of Vienna's U-Bahn and S-Bahn networks. It shows live
U-Bahn departure estimates and scheduled S-Bahn positions.

The Wiener Linien real-time interface publishes departure predictions, not
vehicle GPS coordinates. This app walks each prediction backwards along its
line's official station sequence and estimated segment timings. Train dots are
therefore position estimates, and the interface fades uncertain estimates.
When a line has no usable live prediction, hollow dashed dots show timetable
simulations so they cannot be mistaken for reported trains.

ÖBB's public feed does not provide S-Bahn vehicle GPS. S-Bahn dots are therefore
interpolated between the station times in the official 2026 GTFS timetable and
are always drawn hollow and labelled as scheduled estimates.

## Features

- U1, U2, U3, U4 and U6 on an interactive MapLibre map
- S1, S2, S3, S4, S7, S40, S45, S50, S60 and S80
- Live Wiener Linien departure predictions
- Scheduled ÖBB S-Bahn positions that respect service calendars and exceptions
- Estimated moving train positions and confidence styling
- Clickable train details with direction, adjacent stations and source confidence
- Live Wiener Linien service disruptions highlighted by line and station
- Search across U-Bahn and S-Bahn stations
- Independent U-Bahn/S-Bahn line and train layers, with a marker legend
- Line filters, light/dark themes and nearest-station location
- S-Bahn timetable validity warnings and automatic monthly refresh checks
- Station departure panels with live countdowns
- Full-screen departure board at `?mode=dashboard`
- Automated U-Bahn delay-data collection with chronological holdout evaluation
- Public MAE, RMSE, R², within-one-minute accuracy and 3+ minute delay metrics
- Shared React codebase for the web and a Capacitor iOS shell

The delay model does not publish a score until it has at least seven days of
observations and a sufficiently large untouched test period. Its methodology is
documented in [`docs/ml-delay-model.md`](docs/ml-delay-model.md).

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:5173>.

```bash
npm test
npm run build
```

## GitHub Pages

Pushes to `main` are automatically built and published through the Pages
workflow in `.github/workflows/deploy-pages.yml`. The hosted build routes its
read-only departure requests through the open-source `corsproxy.nl` relay
because the official endpoint does not provide browser CORS headers. The data
still comes directly from Wiener Linien and the relay receives only public
station identifiers.

## Refresh Vienna data

```bash
npm run build:vienna-data
```

That command downloads Wiener Linien's current Open Government Data files and
regenerates the compact line, station, identifier, color and segment-timing
files in `src/data/`.

To refresh the S-Bahn routes and timetable from ÖBB's annual GTFS feed:

```bash
npm run build:sbahn
```

The scheduled `refresh-sbahn.yml` workflow checks for a newer annual feed on
the first day of each month, verifies it, and commits the generated timetable
only when the source data changed. If the bundled calendar has expired, the app
withdraws S-Bahn movements rather than presenting stale scheduled positions.

## Data sources and accuracy

- Static station sequences, coordinates and identifiers: [Wiener Linien Open Data](https://www.wienerlinien.at/open-data)
- Live departures: [Wiener Linien real-time monitor API](https://www.wienerlinien.at/ogd_realtime/doku/ogd/wienerlinien-echtzeitdaten-dokumentation.pdf)
- S-Bahn routes and timetable: [ÖBB GTFS Fahrplan](https://data.oebb.at/de/datensaetze~soll-fahrplan-gtfs~)
- Data attribution: Datenquelle Stadt Wien – <https://data.wien.gv.at>
- Basemap: OpenStreetMap/Esri in a fresh clone

This is an independent project and is not operated or endorsed by Wiener
Linien. Live markers are inferred from arrivals and should not be treated as
exact train locations.

## Acknowledgements

This Vienna adaptation is based on JieGH's original
[vibe_VLCmetroMap](https://github.com/JieGH/vibe_VLCmetroMap) project. The
original Git history and Apache 2.0 license are preserved.

## Privacy

The locate button compares one device location fix against the station list in
the browser. The coordinates are not sent to Wiener Linien or to an application
server.

## License

Code is licensed under Apache 2.0. Vienna open data is published under CC BY.
