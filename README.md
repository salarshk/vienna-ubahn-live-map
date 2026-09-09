# Vienna U-Bahn Live Map

**Website:** <https://salarshk.github.io/vienna-ubahn-live-map/>

An interactive map of Vienna's U-Bahn network that shows live departures and
estimates where trains are between stations.

The Wiener Linien real-time interface publishes departure predictions, not
vehicle GPS coordinates. This app walks each prediction backwards along its
line's official station sequence and estimated segment timings. Train dots are
therefore position estimates, and the interface fades uncertain estimates.
When a line has no usable live prediction, hollow dashed dots show timetable
simulations so they cannot be mistaken for reported trains.

## Features

- U1, U2, U3, U4 and U6 on an interactive MapLibre map
- Live Wiener Linien departure predictions
- Estimated moving train positions and confidence styling
- Search across 99 U-Bahn stations
- Line filters, light/dark themes and nearest-station location
- Station departure panels with live countdowns
- Full-screen departure board at `?mode=dashboard`
- Shared React codebase for the web and a Capacitor iOS shell

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
workflow in `.github/workflows/deploy-pages.yml`.

## Refresh Vienna data

```bash
npm run build:vienna-data
```

That command downloads Wiener Linien's current Open Government Data files and
regenerates the compact line, station, identifier, color and segment-timing
files in `src/data/`.

## Data sources and accuracy

- Static station sequences, coordinates and identifiers: [Wiener Linien Open Data](https://www.wienerlinien.at/open-data)
- Live departures: [Wiener Linien real-time monitor API](https://www.wienerlinien.at/ogd_realtime/doku/ogd/wienerlinien-echtzeitdaten-dokumentation.pdf)
- Data attribution: Datenquelle Stadt Wien – <https://data.wien.gv.at>
- Basemap: OpenStreetMap/Esri in a fresh clone

This is an independent project and is not operated or endorsed by Wiener
Linien. Live markers are inferred from arrivals and should not be treated as
exact train locations.

## Privacy

The locate button compares one device location fix against the station list in
the browser. The coordinates are not sent to Wiener Linien or to an application
server.

## License

Code is licensed under Apache 2.0. Vienna open data is published under CC BY.
