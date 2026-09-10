import React, { useEffect, useRef } from 'react';
import { Map as MapLibreMap, Marker, LngLatBounds, addProtocol, setWorkerUrl } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { noLabels, labels } from 'protomaps-themes-base';
import 'maplibre-gl/dist/maplibre-gl.css';
import metroData from '../data/metro_lines.json';
import gtfsData from '../data/gtfs_expanded.json';
import sbahnData from '../data/sbahn_network.json';
import imageLineColors from '../data/line_colors_from_image.json';
import lineRenderConfig from '../data/line_render_config.js';
import { LANDSCAPE_BREAKPOINT_PX } from '../utils/layout';

// MapLibre derives its worker's URL from import.meta.url, which resolves to a
// file Vite's bundler never writes (maplibre-gl is bundled into the app chunk,
// not kept as its own file) — a build-only 404 that a dev server's raw module
// resolution never hits, which is why this only ever broke in production and
// the native app. Bundling the worker as a Vite asset (?worker&url) was tried
// first and loads without error but never actually starts: MapLibre requests
// it as { type: 'module' }, and Vite's default worker output format is IIFE —
// a mismatch that fails silent, with no console error and no worker activity,
// rather than throwing. Pointing at an unbundled, unmodified copy in public/ —
// the one directory Vite copies verbatim, already used for line4's OSM geojson
// for the same reason — sidesteps both failure modes entirely. Re-copy
// public/vendor/maplibre/*.mjs from node_modules/maplibre-gl/dist/ if the
// maplibre-gl version ever changes.
const APP_BASE_URL = new URL(import.meta.env.BASE_URL, window.location.origin);
setWorkerUrl(new URL('vendor/maplibre/maplibre-gl-worker.mjs', APP_BASE_URL).href);

// Optional offline basemap archive. A fresh clone falls back to online tiles.
//
// Vector rather than raster because the complaint that started this was zoom:
// every raster provider that needs no API key stops having real tiles around
// zoom 16, and CARTO's keyless tiles come back stamped "API KEY REQUIRED".
// Vector tiles have no such ceiling — the archive stops at zoom 15 and MapLibre
// renders it sharp at 20, because it is drawing geometry rather than stretching
// pixels.
// Absolute rather than root-relative: MapLibre rejects a relative sprite URL
// outright ("must be absolute"), and having the archive, glyphs and sprite all
// resolve the same way keeps the native app — served from capacitor://localhost
// rather than http — working off the same three lines.
const BASEMAP_DIR = new URL('basemap', APP_BASE_URL).href.replace(/\/$/, '');
const BASEMAP_ARCHIVE = `${BASEMAP_DIR}/vienna.pmtiles`;

addProtocol('pmtiles', new Protocol().tile);
// Absent until `npm run fetch:basemap` has been run — it is refetchable input,
// not committed data (ADR-0003's rule, and 34 MB of binary has no business in
// git history).
//
// Probed with a one-byte range read rather than a HEAD, because that is exactly
// the request the archive's own reader makes: a server that answers this will
// serve the archive, and one that cannot is no use however it answers a HEAD.
// Vite's dev server, in fact, returns 503 to a HEAD from the browser while
// serving ranges perfectly well.
let OFFLINE_BASEMAP_AVAILABLE = false;
try {
  // eslint-disable-next-line no-undef
  const probe = await fetch(BASEMAP_ARCHIVE, { headers: { Range: 'bytes=0-0' } });
  const contentType = probe.headers.get('content-type') || '';
  OFFLINE_BASEMAP_AVAILABLE = probe.ok && !contentType.includes('text/html');
  if (!OFFLINE_BASEMAP_AVAILABLE) {
    console.warn(
      `Offline basemap unavailable (HTTP ${probe.status}); falling back to online raster tiles, ` +
      'which stop resolving past zoom 16.'
    );
  }
} catch (error) {
  console.warn('Offline basemap unreachable; falling back to online raster tiles.', error);
}

import arrivalStore, { NETWORK_SYNC_INTERVAL_MS, STATION_ID_MAP } from '../services/arrivalStore';
import trainPositionEngine from '../services/trainPositionEngine';
import { getStationFocus } from '../services/stationFocus';
import { countdownHeat, countdownLabel } from '../utils/countdownHeat';
import { getDistance, nearestFeature, nearestPointOnPath } from '../utils/geoUtils';

// Chaikin subdivision to smooth a polyline. Returns a new array of coordinates.
const chaikinSmooth = (coords, iterations = 2) => {
  if (!coords || coords.length < 3) return coords;
  let pts = coords.map(c => c.slice());
  for (let it = 0; it < iterations; it++) {
    const next = [];
    next.push(pts[0]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const q = [p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25];
      const r = [p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75];
      next.push(q, r);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
};

// Deduplicate line features by `properties.line` preferring `metroData` entries.
const lineById = new Map();
// First add metroData lines (they appear first in allFeatures already)
for (const f of metroData.features.filter(f => f.geometry && f.geometry.type === 'LineString')) {
  if (f.properties && f.properties.line) lineById.set(String(f.properties.line), { ...f });
}
for (const f of sbahnData.features.filter(f => f.geometry && f.geometry.type === 'LineString')) {
  if (f.properties && f.properties.line) lineById.set(String(f.properties.line), { ...f });
}
// Then add GTFS lines only if not present or if configured to prefer GTFS for a given line
for (const f of (gtfsData && gtfsData.features ? gtfsData.features : []).filter(f => f.geometry && f.geometry.type === 'LineString')) {
  const id = f.properties && f.properties.line && String(f.properties.line);
  if (!id) continue;
  const preferGTFS = Array.isArray(lineRenderConfig.useGTFS) && lineRenderConfig.useGTFS.map(String).includes(id);
  if (preferGTFS) {
    lineById.set(id, { ...f });
  } else if (!lineById.has(id)) {
    lineById.set(id, { ...f });
  }
}

// Draw the regional S-Bahn corridors first so the denser U-Bahn remains
// legible where the networks cross in the city centre.
let lineFeatures = Array.from(lineById.values()).sort((a, b) =>
  (a.properties?.mode === 'sbahn' ? 0 : 1) - (b.properties?.mode === 'sbahn' ? 0 : 1)
);
// Ensure each feature has a resolved `color` property (image override > feature.color > default)
for (const f of lineFeatures) {
  const lid = String(f.properties.line);
  const override = imageLineColors && imageLineColors[lid];
  f.properties = { ...f.properties, mode: f.properties.mode || 'ubahn', color: override || f.properties.color || '#888888', offset: 0 };
}
// Smooth configured lines so their rendered curves match.
const smoothingApplyTo = (lineRenderConfig && lineRenderConfig.smoothing && Array.isArray(lineRenderConfig.smoothing.applyTo))
  ? lineRenderConfig.smoothing.applyTo.map(String)
  : ['3', '4', '9'];
const smoothingIterations = (lineRenderConfig && lineRenderConfig.smoothing && Number.isFinite(lineRenderConfig.smoothing.iterations))
  ? lineRenderConfig.smoothing.iterations
  : 2;
lineFeatures = lineFeatures.map((f) => {
  const id = f.properties && String(f.properties.line);
  if (smoothingApplyTo.includes(id)) {
    const coords = f.geometry && f.geometry.coordinates;
    if (coords && coords.length > 4) {
      try {
        const smoothed = chaikinSmooth(coords, smoothingIterations);
        return { ...f, geometry: { ...f.geometry, coordinates: smoothed } };
      } catch {
        return f;
      }
    }
  }
  return f;
});
// gtfs_expanded.json carries every station on the network, so it is the single
// source here; metro_lines.json only contributes points it alone knows about.
const gtfsStations = (gtfsData && gtfsData.features)
  ? gtfsData.features.filter(f => f.geometry.type === 'Point')
  : [];
const gtfsStationNames = new Set(gtfsStations.map(f => f.properties.name));
const rawStations = [
  ...gtfsStations,
  ...sbahnData.features.filter(f => f.geometry.type === 'Point'),
  ...metroData.features.filter(
    f => f.geometry.type === 'Point' && !gtfsStationNames.has(f.properties.name)
  ),
];

// How far a Station is allowed to be from its Line before snapping it there
// would be a lie rather than a correction. Beyond this it is an Off-Track
// Station — the geometry omits the branch it actually sits on (ADR-0002), and
// dragging it onto the wrong track would put it visibly nowhere near where it
// is. Anything beyond this stays where the source data puts it.
const SNAP_LIMIT_M = 200;

// Two features this close together, resolving to the same station in the live
// API, are one Station spelled two ways rather than two Stations.
const DUPLICATE_LIMIT_M = 150;

const stationApiId = (properties) => {
  if (!properties || !properties.name) return null;
  const direct = STATION_ID_MAP[properties.name];
  if (direct !== undefined) return Number(direct);
  const lower = STATION_ID_MAP[properties.name.toLowerCase().trim()];
  return lower === undefined ? null : Number(lower);
};

// "Pl. Espanya" and "Plaça Espanya" are 99 m apart in the data and both resolve
// to station 51 in the live API: one interchange drawn as two dots, each
// showing half its Lines. Merged into whichever came from GTFS — the single
// source above — carrying the union of both features' Lines.
const mergeDuplicateStations = (stations) => {
  const kept = [];
  const byApiId = new Map();

  for (const station of stations) {
    const apiId = stationApiId(station.properties);
    const twin = apiId === null ? null : byApiId.get(apiId);

    if (twin && getDistance(twin.geometry.coordinates, station.geometry.coordinates) < DUPLICATE_LIMIT_M) {
      const lines = new Set([
        ...(twin.properties.lines || []),
        ...(station.properties.lines || []),
      ]);
      twin.properties = { ...twin.properties, lines: [...lines] };
      continue;
    }

    // Cloned rather than mutated in place: trainPositionEngine imports the same
    // gtfs_expanded.json objects, and moving a Station under it would shift
    // every position walked through that Station.
    const clone = {
      ...station,
      properties: { ...station.properties },
      geometry: { ...station.geometry, coordinates: station.geometry.coordinates.slice() },
    };
    kept.push(clone);
    if (apiId !== null && !byApiId.has(apiId)) byApiId.set(apiId, clone);
  }

  return kept;
};

// Station centres and platform alignments can disagree by tens of metres.
// Snapping the marker onto the alignment the map actually draws is a rendering
// correction only: the Timetable Walk keeps projecting from the feed's own
// coordinates, so nothing about where trains are placed changes.
const snapStationToItsLines = (station) => {
  const lines = station.properties.lines || [];
  let best = null;

  for (const lineId of lines) {
    const geometry = lineCoordsById.get(String(lineId));
    if (!geometry) continue;
    const candidate = nearestPointOnPath(geometry, station.geometry.coordinates);
    if (candidate && (!best || candidate.distance < best.distance)) best = candidate;
  }

  if (!best || best.distance > SNAP_LIMIT_M) return station;

  station.geometry.coordinates = best.coordinates;
  return station;
};

const lineCoordsById = new Map(
  lineFeatures
    .filter(f => f.geometry && f.geometry.type === 'LineString')
    .map(f => [String(f.properties.line), f.geometry.coordinates])
);

const stationFeatures = mergeDuplicateStations(rawStations).map(snapStationToItsLines);

// Snapped positions are what the map draws, so a Station handed in from
// somewhere that has not snapped it — userLocation's Nearest Station, say —
// still has to be drawn and framed at the same place as its own dot.
const snappedByName = new Map(stationFeatures.map(f => [f.properties.name, f]));
const snappedCoordinates = (station) => {
  const snapped = station && snappedByName.get(station.properties.name);
  return snapped ? snapped.geometry.coordinates : station.geometry.coordinates;
};
const lineGeoJSON    = { type: 'FeatureCollection', features: lineFeatures };
const emptyFeatureCollection = { type: 'FeatureCollection', features: [] };

// Build a color lookup from line id → color from actual GeoJSON data,
// allowing overrides from the sampled image colors file.
const lineColorMap = Object.fromEntries(
  lineFeatures.map(f => [f.properties.line, (imageLineColors && imageLineColors[f.properties.line]) ? imageLineColors[f.properties.line] : f.properties.color])
);

const cartoApiKey = import.meta.env.VITE_CARTO_API_KEY;

// CARTO tiles (used when API key is provided, appending ?api_key=...)
const getCartoTiles = (variant) => {
  const keyParam = cartoApiKey ? `?api_key=${cartoApiKey}` : '';
  return [
    `https://a.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}.png${keyParam}`,
    `https://b.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}.png${keyParam}`,
    `https://c.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}.png${keyParam}`,
    `https://d.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}.png${keyParam}`,
  ];
};

// Clean, keyless dark and light canvas tiles (Esri Gray Canvas)
// Used when no CARTO API key is provided so tiles never display "API KEY REQUIRED" watermarks
const KEYLESS_DARK_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
];
const KEYLESS_LIGHT_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'
];

const DARK_TILES = cartoApiKey ? getCartoTiles('dark_all') : KEYLESS_DARK_TILES;
const LIGHT_TILES = cartoApiKey ? getCartoTiles('light_all') : KEYLESS_LIGHT_TILES;
const TILE_ATTRIBUTION = cartoApiKey ? '© OpenStreetMap © CARTO' : '© OpenStreetMap © Esri';

// The Line layers, as a template both basemaps below clone. They sit above the
// basemap's own geometry and below its labels, so a street name stays readable
// where a Line crosses it while the Lines themselves are never buried under a
// road. Cloned rather than shared for the reason given at styleFor.
const metroLayers = [
  {
    id: 'metro-casing',
    type: 'line',
    source: 'metro-lines',
    paint: {
      'line-color': '#000000',
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        6, 1.2,
        8, 1.8,
        10, 2.6,
        11.5, 3.4,
        13, 4.6,
        15, 6.2,
        17, 8.5,
        19, 11.0
      ],
      'line-opacity': ['case', ['==', ['get', 'mode'], 'sbahn'], 0.22, 0.35],
      'line-offset': [
        'interpolate', ['linear'], ['zoom'],
        6, 0,
        8, ['*', ['get', 'offset'], 0.15],
        10, ['*', ['get', 'offset'], 0.35],
        11.5, ['*', ['get', 'offset'], 0.6],
        13, ['*', ['get', 'offset'], 0.85],
        15, ['*', ['get', 'offset'], 1.1],
        17, ['*', ['get', 'offset'], 1.4],
        19, ['*', ['get', 'offset'], 1.8]
      ]
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  },
  {
    id: 'metro-fill',
    type: 'line',
    source: 'metro-lines',
    paint: {
      'line-color': ['get', 'color'],
      'line-opacity': ['case', ['==', ['get', 'mode'], 'sbahn'], 0.72, 1],
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        6, 0.75,
        8, 1.2,
        10, 1.8,
        11.5, 2.4,
        13, 3.4,
        15, 4.8,
        17, 6.8,
        19, 9.0
      ],
      'line-offset': [
        'interpolate', ['linear'], ['zoom'],
        6, 0,
        8, ['*', ['get', 'offset'], 0.15],
        10, ['*', ['get', 'offset'], 0.35],
        11.5, ['*', ['get', 'offset'], 0.6],
        13, ['*', ['get', 'offset'], 0.85],
        15, ['*', ['get', 'offset'], 1.1],
        17, ['*', ['get', 'offset'], 1.4],
        19, ['*', ['get', 'offset'], 1.8]
      ]
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  },
  {
    id: 'position-confidence-range',
    type: 'line',
    source: 'position-confidence',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 13, 9, 17, 15],
      'line-opacity': ['interpolate', ['linear'], ['get', 'confidence'], 0.35, 0.24, 1, 0.08],
      'line-blur': 2,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  },
  {
    id: 'position-confidence-centre',
    type: 'line',
    source: 'position-confidence',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 13, 2, 17, 3],
      'line-opacity': 0.72,
      'line-dasharray': [1.2, 1.6],
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  },
  {
    id: 'service-alert-line',
    type: 'line',
    source: 'metro-lines',
    filter: ['==', ['get', 'line'], '__no_active_alert__'],
    paint: {
      'line-color': '#ff3b30',
      'line-opacity': 0.95,
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        6, 2.4,
        10, 4.2,
        14, 7.5,
        18, 12
      ],
      'line-dasharray': [1.2, 1.2],
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  },
];

// Raster fallback, used only when the offline archive is missing. Esri's Gray
// Canvas stops having real tiles at zoom 16 and serves a "map data not yet
// available" placeholder above it, which is exactly why the offline vector
// basemap exists — but a clone that has not run `npm run fetch:basemap` should
// still get a map rather than a void.
const buildRasterStyle = (tiles, tileSourceId) => ({
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    [tileSourceId]: { type: 'raster', tiles, tileSize: 256, attribution: TILE_ATTRIBUTION, maxzoom: 16 },
    'metro-lines': { type: 'geojson', data: lineGeoJSON, tolerance: 0.6, buffer: 128, attribution: 'U-Bahn: Stadt Wien · S-Bahn: ÖBB GTFS' },
    'position-confidence': { type: 'geojson', data: emptyFeatureCollection },
  },
  layers: [
    { id: `${tileSourceId}-tiles`, type: 'raster', source: tileSourceId },
    ...structuredClone(metroLayers),
  ],
});

// Protomaps' basemap flavours. 'white' gives the clean near-white ground the
// app already had; 'dark' rather than 'black' for the other, because 'black'
// paints earth #141414 under roads #333333 and the structure of the city simply
// does not survive that little contrast — it reads as an empty screen with
// Lines floating on it. Each flavour names its own sprite file.
const THEME_FLAVOURS = { dark: 'dark', light: 'white' };

const buildVectorStyle = (flavour) => ({
  version: 8,
  glyphs: `${BASEMAP_DIR}/fonts/{fontstack}/{range}.pbf`,
  sprite: `${BASEMAP_DIR}/sprites/${flavour}`,
  sources: {
    protomaps: {
      type: 'vector',
      url: `pmtiles://${BASEMAP_ARCHIVE}`,
      attribution: '© OpenStreetMap · Protomaps',
    },
    'metro-lines': { type: 'geojson', data: lineGeoJSON, tolerance: 0.6, buffer: 128, attribution: 'U-Bahn: Stadt Wien · S-Bahn: ÖBB GTFS' },
    'position-confidence': { type: 'geojson', data: emptyFeatureCollection },
  },
  // Basemap geometry, then the Lines, then the basemap's labels on top.
  layers: [
    ...noLabels('protomaps', flavour),
    ...structuredClone(metroLayers),
    ...labels('protomaps', flavour, 'en'),
  ],
});

// Built fresh on every call rather than held as two module-level constants.
// MapLibre takes ownership of the style object it is handed and mutates it, and
// StrictMode mounts this component twice in dev: the first map consumed the
// shared object and the second one — the live one — got the leftovers, so the
// basemap and the Lines both silently failed to draw while the console stayed
// clean. Toggling the theme appeared to fix it only because that handed over
// the other, still-untouched object.
const styleFor = (theme) => (OFFLINE_BASEMAP_AVAILABLE
  ? buildVectorStyle(theme === 'dark' ? THEME_FLAVOURS.dark : THEME_FLAVOURS.light)
  : buildRasterStyle(
    theme === 'dark' ? DARK_TILES : LIGHT_TILES,
    theme === 'dark' ? 'basemap-dark' : 'basemap-light'
  ));

// The CSS opacity a vehicle marker is drawn at. For a live train that is its
// Position Confidence; scheduled S-Bahn trains stay visually distinct but no
// longer fade into the basemap, while generic simulations remain subdued.
const vehicleOpacity = (v) =>
  (v.isLive ? (v.positionConfidence ?? 1) : v.isScheduled ? 0.9 : 0.55).toFixed(2);

// Says in the reader's words — not the model's — why a marker is drawn faint,
// covering both causes: how far the walk had to reach, and how long since the
// API last confirmed the train.
const describePositionDoubt = (v) => {
  if (!v.isLive || v.positionConfidence >= 1) return '';
  const confirmed = v.secondsUnheard < 60
    ? 'just now'
    : `${Math.round(v.secondsUnheard / 60)} min ago`;
  const basis = v.isDeadReckoned
    ? 'position estimated past its last prediction'
    : `position estimated ±${v.positionUncertaintyMetres} m`;
  return ` • ${basis}, last confirmed ${confirmed}`;
};

// The expanded Station node's markup. Built as a string because it lives inside
// a MapLibre Marker, outside React's tree, and is redrawn every second.
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

const renderFocusNode = (focus, theme) => {
  const panel = theme === 'light' ? '#ffffff' : '#1e1e24';
  const text = theme === 'light' ? '#121212' : '#ffffff';
  const muted = theme === 'light' ? '#5f6368' : '#a0a0b0';
  const border = theme === 'light' ? 'rgba(0,0,0,.14)' : 'rgba(255,255,255,.16)';

  // No destination text here — only badge, arrow and countdown. The full
  // The combined destination label lives in the docked Station
  // panel, which has the width for it; found by testing against real station
  // names that even two names joined don't fit this bubble's width, and
  // showing it twice (truncated here, in full in the panel) was the
  // duplication that made both surfaces read as cluttered.
  const arms = focus.directions.map((direction) => {
    const next = direction.arrivals[0];
    // The arrow points the way the track actually leaves this Station, which is
    // why each Direction Group carries a bearing. 0° is north; the glyph points
    // up at rest, so the bearing rotates it directly.
    const rotation = direction.bearing === null ? 0 : Math.round(direction.bearing);
    const badge = next
      ? `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:6px;background:${lineColorMap[next.line] || '#8a8a8a'};color:#000;font:900 12px/1 system-ui">${escapeHtml(next.line)}</span>`
      : '';
    const due = next
      ? `<span style="font:800 18px/1 system-ui;font-variant-numeric:tabular-nums;color:${countdownHeat(next.seconds, theme)}">${countdownLabel(next.seconds)}</span>`
      : `<span style="font:600 11px/1 system-ui;color:${muted}">none</span>`;

    return `
      <div style="display:flex;align-items:center;gap:9px;padding:8px 12px">
        <span aria-hidden="true" style="display:inline-block;font:700 14px/1 system-ui;color:${muted};transform:rotate(${rotation}deg)">&#9650;</span>
        ${badge}
        <span style="flex:1"></span>
        ${due}
      </div>`;
  }).join(`<div style="height:1px;background:${border}"></div>`);

  return `
    <div style="min-width:150px;max-width:200px;border-radius:12px;background:${panel};border:1px solid ${border};box-shadow:0 10px 30px rgba(0,0,0,.45);overflow:hidden">
      <div style="padding:8px 10px 6px;border-bottom:1px solid ${border}">
        <div style="font:800 13px/1.2 system-ui;color:${text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(focus.name)}</div>
        <div style="font:600 9px/1.2 system-ui;letter-spacing:.1em;text-transform:uppercase;color:${focus.isFresh ? '#4CAF50' : '#00B4D8'};margin-top:3px">${focus.isFresh ? 'Live API' : 'From memory'}</div>
      </div>
      ${arms || `<div style="padding:9px 10px;font:600 11px/1 system-ui;color:${muted}">No live trains</div>`}
    </div>`;
};

/** Picks the first line's color for a station marker border */
const stationBorderColor = (st) => {
  const lines = st.properties.lines || [];
  return lines.length > 0 ? (lineColorMap[lines[0]] || '#aaaaaa') : '#aaaaaa';
};

const normaliseStationName = (value) => String(value || '')
  .toLocaleLowerCase('de-AT')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// ─── Component ────────────────────────────────────────────────────────────────
// The zoom a focused Station eases to. Close enough that the expanded node has
// room beside its neighbours, not so close that the rest of the Line leaves the
// screen and the map stops being a map.
const STATION_FOCUS_ZOOM = 14.6;

// The radius, in screen pixels, within which a tap counts as meaning a Station.
// A Station dot is drawn 10 px across, which is a quarter of the 44 px Apple
// asks for as a minimum touch target and the reason the map had to be zoomed
// right in before a station could be hit at all. 22 px gives that 44 px target
// without drawing anything bigger.
//
// Enlarging each marker's own hit box would have been the obvious fix and the
// wrong one: neighbouring Stations are 99 m apart at the closest and 387 m at
// the first quartile, so at normal zoom those boxes overlap, and an overlap
// between DOM elements is settled by which one happens to be on top rather than
// which one you meant. Resolving the tap to the *nearest* Station within the
// radius settles it by distance instead, which is the thing the finger was
// actually aiming at.
const TAP_RADIUS_PX = 22;

// How close framing the viewer against their Nearest Station is allowed to get.
// Without a cap, standing 40 m from a platform fills the screen with one
// junction and the map stops being a map.
const USER_FRAME_MAX_ZOOM = 15.5;

// A User Location is a single fix, taken once, and it starts going stale
// immediately — you can walk 500 m in the time it takes to read a departure
// board. Rather than let a stale dot keep claiming to be current, it fades as
// it ages, on a floor, for the same reason Position Confidence has one: a
// position that has become a guess must read as uncertain, not absent.
const USER_FIX_FADE_MS = 300000;
const USER_FIX_OPACITY_FLOOR = 0.4;

const userFixOpacity = (ageMs) => {
  const spent = Math.min(1, Math.max(0, ageMs / USER_FIX_FADE_MS));
  return (1 - spent * (1 - USER_FIX_OPACITY_FLOOR)).toFixed(3);
};

// Metres per pixel at a given latitude and zoom. The accuracy circle is a real
// distance, so it has to be redrawn at every zoom rather than pinned to a pixel
// size — a fixed circle would claim a different accuracy at every scale.
const metresPerPixel = (latitude, zoom) =>
  (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);

// What the Station panel and the search bar actually cover right now, so the
// camera centres on the map still visible rather than behind them. Measured
// rather than assumed from the CSS: both the bottom sheet's maxHeight:58vh and
// the right rail's width:min(380px,34vw) are content-sized caps, not fixed
// sizes, and the panel renders shorter than its cap now that its arrivals
// table stops at three rows.
const panelAwarePadding = (map) => {
  const isLandscape = window.innerWidth >= LANDSCAPE_BREAKPOINT_PX;
  const containerRect = map.getContainer().getBoundingClientRect();
  const searchBarRect = document.querySelector('.search-bar-container')?.getBoundingClientRect();
  const panelRect = document.querySelector('.station-panel')?.getBoundingClientRect();

  return isLandscape
    ? {
        top: (searchBarRect ? searchBarRect.bottom - containerRect.top : 84) + 12,
        right: (panelRect ? containerRect.right - panelRect.left : Math.min(380, window.innerWidth * 0.34)) + 16,
        bottom: 40,
        left: 40,
      }
    : {
        top: (searchBarRect ? searchBarRect.bottom - containerRect.top : 90) + 12,
        right: 24,
        bottom: (panelRect ? containerRect.bottom - panelRect.top : window.innerHeight * 0.58) + 16,
        left: 24,
      };
};

const MapView = ({
  theme,
  selectedStation,
  flyTarget,
  onSelectStation,
  activeLineFilter,
  hoverLine,
  userLocation,
  mapVisibility,
  disruptions = [],
  onSelectDisruption,
  onSelectVehicle,
  replaySnapshot = null,
}) => {
  const containerRef    = useRef(null);
  const mapRef          = useRef(null);
  const stMarkersRef    = useRef([]);
  const alertMarkersRef = useRef([]);
  const animFrameRef    = useRef(null);
  // native JS Map of vehicle id → { marker, inner }. The inner element is kept
  // alongside its marker because the animation loop restyles it every frame,
  // and rediscovering it by walking the marker's DOM would tie the loop to a
  // wrapper structure built far away in createVehicleMarker.
  const markerMapRef    = useRef(new globalThis.Map());
  const themeRef        = useRef(theme);
  const filterRef       = useRef(activeLineFilter);
  const hoverRef        = useRef(null);
  const visibilityRef   = useRef(mapVisibility);
  const replayRef       = useRef(replaySnapshot);
  const disruptionsRef  = useRef(disruptions);
  const selectStRef     = useRef(onSelectStation);
  const selectVehicleRef= useRef(onSelectVehicle);
  const selectAlertRef  = useRef(onSelectDisruption);
  const trainCountRef   = useRef(null);
  const focusMarkerRef  = useRef(null); // the expanded node for the Station in focus
  const zoomScaleRef    = useRef(1); // mutable scale factor updated on every zoom event
  const stInnerElemsRef = useRef([]); // refs to station inner elements for direct scale updates
  // The Stations actually drawn right now, which is not every Station: a Line
  // filter or a hovered Line narrows them. A tap must only ever resolve to
  // something the viewer can currently see.
  const drawnStationsRef = useRef([]);
  const vehInnerElemsRef= useRef([]); // refs to vehicle inner elements for direct scale updates
  const lastRangeUpdateRef = useRef(0);

  useEffect(() => { themeRef.current = theme; }, [theme]);
  useEffect(() => { filterRef.current = activeLineFilter; }, [activeLineFilter]);
  useEffect(() => { selectStRef.current = onSelectStation; }, [onSelectStation]);
  useEffect(() => { selectVehicleRef.current = onSelectVehicle; }, [onSelectVehicle]);
  useEffect(() => { selectAlertRef.current = onSelectDisruption; }, [onSelectDisruption]);
  useEffect(() => { hoverRef.current = hoverLine; }, [hoverLine]);
  useEffect(() => { visibilityRef.current = mapVisibility; }, [mapVisibility]);
  useEffect(() => { replayRef.current = replaySnapshot; }, [replaySnapshot]);
  useEffect(() => { disruptionsRef.current = disruptions; }, [disruptions]);

  const stopAnimation = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  };

  const clearVehicleMarkers = () => {
    markerMapRef.current.forEach(({ marker }) => marker.remove());
    markerMapRef.current.clear();
    vehInnerElemsRef.current = [];
  };

  const clearStationMarkers = () => {
    stMarkersRef.current.forEach(m => m.remove());
    stMarkersRef.current = [];
    stInnerElemsRef.current = [];
  };

  const clearAlertMarkers = () => {
    alertMarkersRef.current.forEach((marker) => marker.remove());
    alertMarkersRef.current = [];
  };

  // Apply zoom-based scale directly to all known marker DOM elements
  const applyMarkerScale = (scale) => {
    zoomScaleRef.current = scale;

    // Station markers: hide below scale 0.55 (~zoom 9.7), scale above that
    stInnerElemsRef.current.forEach(el => {
      if (scale < 0.55) {
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
      } else {
        el.style.visibility = '';
        el.style.pointerEvents = '';
        el.style.transform = `scale(${Math.min(1.2, scale).toFixed(3)})`;
      }
    });

    // Vehicle markers: hide below scale 0.3 (~zoom 8.7), scale above
    vehInnerElemsRef.current.forEach(el => {
      if (scale < 0.3) {
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
      } else {
        el.style.visibility = '';
        el.style.pointerEvents = '';
        el.style.transform = `scale(${Math.min(1.1, scale).toFixed(3)})`;
      }
    });
  };

  // Says plainly whether a marker is a reported train or a headway guess, and
  // how many independent sightings pin it down.
  const describeVehicle = (v) => {
    if (v.isReplay) {
      return `${v.line} → ${v.direction} • replayed estimate from ${new Date(v.replayedAt).toLocaleTimeString()}`;
    }
    if (v.isScheduled) {
      const eta = v.secondsToTarget <= 0
        ? 'at platform'
        : `${Math.round(v.secondsToTarget / 60)} min to`;
      return `${v.line} → ${v.direction} • ${eta} ${v.targetStation} • scheduled estimate, no live GPS`;
    }
    if (!v.isLive) {
      return `${v.line} → ${v.direction} • simulated from the timetable, not a reported train`;
    }
    const eta = v.secondsToTarget <= 0
      ? 'at platform'
      : `${Math.round(v.secondsToTarget / 60)} min to`;
    const pin = v.sightingCount > 1 ? ` • ${v.sightingCount} sightings` : '';
    return `${v.line} → ${v.direction} • ${eta} ${v.targetStation}${pin}${describePositionDoubt(v)}`;
  };

  const updateTrainCount = (vehicles = null) => {
    if (!trainCountRef.current) return;
    const now = Date.now();
    const allVehicles = vehicles || trainPositionEngine.getAllVehicles(now);
    const liveVehicles = allVehicles.filter((vehicle) => vehicle.isLive);
    const scheduledVehicles = allVehicles.filter((vehicle) => vehicle.isScheduled);
    if (liveVehicles.length > 0) {
      const pinned = liveVehicles.filter(v => v.sightingCount > 1).length;
      const liveLabel = pinned > 0
        ? `${liveVehicles.length} live trains · ${pinned} confirmed at two stations`
        : `${liveVehicles.length} live trains`;
      trainCountRef.current.textContent = scheduledVehicles.length > 0
        ? `${liveLabel} · ${scheduledVehicles.length} scheduled S-Bahn`
        : liveLabel;
    } else if (scheduledVehicles.length > 0) {
      trainCountRef.current.textContent = `${scheduledVehicles.length} scheduled S-Bahn trains`;
    } else {
      trainCountRef.current.textContent = 'No live predictions — showing simulated trains';
    }
  };

  // ── Initialize station markers ─────────────────────────────────────────────
  // Outer element is owned by MapLibre (for position: transform translate3d).
  // Inner child element handles scale and visuals so MapLibre transform is NEVER overwritten.
  const initStationMarkers = (map) => {
    clearStationMarkers();
    const isDark = themeRef.current === 'dark';
    const activeFilter = filterRef.current;
    const hovered = hoverRef.current;
    const visibility = visibilityRef.current || {};
    const seenStops = new Set();
    const scale = zoomScaleRef.current;

    const filteredStations = stationFeatures.filter((st) => {
      const lines = (st.properties.lines || []).map(String);
      const networkVisible = lines.some((line) =>
        (line.startsWith('S') && visibility.sbahnLines !== false) ||
        (!line.startsWith('S') && visibility.ubahnLines !== false)
      );
      if (!networkVisible) return false;
      if (hovered) {
        return lines.includes(hovered);
      }
      if (Array.isArray(activeFilter) && activeFilter.length > 0) {
        return lines.some(l => activeFilter.includes(String(l)));
      }
      return true;
    });

    drawnStationsRef.current = [];

    filteredStations.forEach((st) => {
      const sid = st.properties.stop_id || st.properties.id || st.properties.name;
      if (!sid) return;
      if (seenStops.has(sid)) return;
      seenStops.add(sid);
      drawnStationsRef.current.push(st);

      const wrapper = document.createElement('div');
      wrapper.className = 'ml-station-marker-wrapper';
      // Fixed wrapper size; inner scales via transform so MapLibre anchor stays correct
      wrapper.style.cssText = 'width:10px; height:10px; cursor:pointer; z-index:1; overflow:visible;';

      const inner = document.createElement('div');
      const isHovered = hoverRef.current && (st.properties.lines || []).includes(hoverRef.current);
      const isHidden = scale < 0.55;
      
      inner.style.cssText = `
        width:10px; height:10px; border-radius:50%;
        background:${isDark ? '#1a1a2e' : '#ffffff'};
        border:${isHovered ? '3px' : '2px'} solid ${stationBorderColor(st)};
        box-shadow:0 2px 6px rgba(0,0,0,.5);
        transition:transform .1s ease;
        transform: scale(${Math.min(1.2, scale).toFixed(3)});
        visibility: ${isHidden ? 'hidden' : ''};
        pointer-events: ${isHidden ? 'none' : ''};
        box-sizing:border-box;
        transform-origin: center center;
      `;
      wrapper.appendChild(inner);
      wrapper.title = st.properties.name;
      stInnerElemsRef.current.push(inner);

      wrapper.onmouseenter = () => { inner.style.transform = `scale(${(zoomScaleRef.current * 1.5).toFixed(3)})`; };
      wrapper.onmouseleave = () => { inner.style.transform = `scale(${zoomScaleRef.current.toFixed(3)})`; };
      wrapper.onclick = (e) => {
        e.stopPropagation();
        selectStRef.current(st);
      };

      const marker = new Marker({ element: wrapper, anchor: 'center' })
        .setLngLat(st.geometry.coordinates)
        .addTo(map);

      stMarkersRef.current.push(marker);
    });
  };

  const initAlertMarkers = (map) => {
    clearAlertMarkers();
    const visible = visibilityRef.current || {};
    if (visible.ubahnLines === false) return;

    const stationByName = new Map(stationFeatures.map((station) => [
      normaliseStationName(station.properties.name), station,
    ]));
    const placed = new Set();

    disruptionsRef.current.forEach((alert) => {
      const wanted = normaliseStationName(alert.station);
      if (!wanted) return;
      let station = stationByName.get(wanted);
      if (!station) {
        station = stationFeatures.find((candidate) => {
          const name = normaliseStationName(candidate.properties.name);
          return wanted.length >= 5 && (name.includes(wanted) || wanted.includes(name));
        });
      }
      if (!station) return;

      const key = `${station.properties.name}|${alert.id}`;
      if (placed.has(key)) return;
      placed.add(key);

      const element = document.createElement('div');
      element.className = 'map-service-alert-marker';
      element.setAttribute('role', 'button');
      element.tabIndex = 0;
      element.setAttribute('aria-label', `Service alert at ${station.properties.name}: ${alert.title}`);
      element.title = `${alert.title}${alert.status ? ` • ${alert.status}` : ''}`;
      element.textContent = '!';
      element.onclick = (event) => {
        event.stopPropagation();
        selectAlertRef.current?.(alert);
      };
      element.onkeydown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        element.onclick(event);
      };

      const marker = new Marker({ element, anchor: 'center', offset: [8, -8] })
        .setLngLat(snappedCoordinates(station))
        .addTo(map);
      alertMarkersRef.current.push(marker);
    });
  };

  // ── Initialize vehicle animation loop ──────────────────────────────────────
  const initVehicleLoop = (map) => {
    stopAnimation();
    clearVehicleMarkers();

    const activeFilter = filterRef.current;
    const displayedVehicles = (now) => replayRef.current
      ? replayRef.current.vehicles.map((vehicle) => ({
        ...vehicle,
        isReplay: true,
        replayedAt: replayRef.current.at,
      }))
      : trainPositionEngine.getAllVehicles(now);
    const initialVehicles = displayedVehicles(Date.now());
    const vehicleIsVisible = (vehicle) => vehicle.isScheduled
      ? visibilityRef.current?.scheduledTrains !== false
      : visibilityRef.current?.liveTrains !== false;
    let visible = initialVehicles.filter(vehicleIsVisible);
    if (Array.isArray(activeFilter) && activeFilter.length > 0) {
      visible = visible.filter(v => activeFilter.includes(String(v.line)));
    }

    const createVehicleMarker = (v) => {
      const color = lineColorMap[v.line] || '#ffffff';
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'width:28px; height:28px; cursor:pointer; z-index:1000; overflow:visible;';
      wrapper.setAttribute('role', 'button');
      wrapper.tabIndex = 0;

      const inner = document.createElement('div');
      const currentScale = zoomScaleRef.current;
      const isHidden = currentScale < 0.3;
      
      inner.innerHTML = `<span style="pointer-events:none">${v.line}</span>`;
      // Scheduled S-Bahn trains retain a dashed outline, but use a light fill,
      // heavier border and glow so the estimate remains easy to find. Generic
      // headway simulations stay hollow and subdued.
      inner.style.cssText = `
        width:28px; height:28px; border-radius:50%;
        background:${v.isLive ? color : v.isScheduled ? `${color}38` : 'transparent'};
        border:${v.isScheduled ? '3px' : '2px'} ${v.isLive ? 'solid rgba(255,255,255,0.9)' : `dashed ${color}`};
        box-shadow:${v.isScheduled ? `0 0 10px 2px ${color}88` : `0 0 0 0 ${color}`};
        display:flex; align-items:center; justify-content:center;
        color:${v.isLive ? '#fff' : color}; font-size:10px; font-weight:800;
        opacity:${vehicleOpacity(v)};
        ${v.isLive ? 'animation: vehiclePulse 2s ease-in-out infinite;' : ''}
        box-sizing:border-box; position:relative;
        transform: scale(${Math.min(1.1, currentScale).toFixed(3)});
        visibility: ${isHidden ? 'hidden' : ''};
        pointer-events: ${isHidden ? 'none' : ''};
        transform-origin: center center;
        transition: transform .1s ease;
      `;
      wrapper.appendChild(inner);
      vehInnerElemsRef.current.push(inner);

      wrapper.title = describeVehicle(v);
      wrapper.setAttribute('aria-label', describeVehicle(v));
      const select = (event) => {
        event.stopPropagation();
        const latest = markerMapRef.current.get(v.id)?.vehicle || v;
        selectVehicleRef.current?.(latest);
      };
      wrapper.onclick = select;
      wrapper.onkeydown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        select(event);
      };

      const marker = new Marker({ element: wrapper, anchor: 'center' })
        .setLngLat(v.coordinates)
        .addTo(map);

      markerMapRef.current.set(v.id, { marker, inner, vehicle: v });
    };

    visible.forEach(createVehicleMarker);

    const updatePositionRanges = (vehicles, now, force = false) => {
      if (!force && now - lastRangeUpdateRef.current < 1000) return;
      lastRangeUpdateRef.current = now;
      const source = map.getSource('position-confidence');
      if (!source || typeof source.setData !== 'function') return;
      const enabled = visibilityRef.current?.confidenceRanges !== false;
      const features = enabled ? vehicles
        .filter((vehicle) => vehicle.isLive && vehicle.positionRangeCoordinates?.length > 1)
        .map((vehicle) => ({
          type: 'Feature',
          properties: {
            id: vehicle.id,
            line: vehicle.line,
            color: lineColorMap[vehicle.line] || '#ffffff',
            confidence: vehicle.positionConfidence ?? 0.5,
          },
          geometry: { type: 'LineString', coordinates: vehicle.positionRangeCoordinates },
        })) : [];
      source.setData({ type: 'FeatureCollection', features });
    };
    updatePositionRanges(visible, Date.now(), true);

    const animate = () => {
      const now = Date.now();
      const currentVehicles = displayedVehicles(now);
      updateTrainCount(currentVehicles);
      let currentVisible = currentVehicles.filter(vehicleIsVisible);
      if (Array.isArray(filterRef.current) && filterRef.current.length > 0) {
        currentVisible = currentVisible.filter(v => filterRef.current.includes(String(v.line)));
      }
      updatePositionRanges(currentVisible, now);
      const visibleIds = new Set(currentVisible.map(v => v.id));

      markerMapRef.current.forEach(({ marker }, id) => {
        if (!visibleIds.has(id)) {
          marker.remove();
          markerMapRef.current.delete(id);
        }
      });

      currentVisible.forEach((v) => {
        const existing = markerMapRef.current.get(v.id);
        if (existing) {
          existing.marker.setLngLat(v.coordinates);
          existing.marker.getElement().title = describeVehicle(v);
          existing.marker.getElement().setAttribute('aria-label', describeVehicle(v));
          existing.vehicle = v;
          // Confidence moves while the train does — the countdown runs down,
          // syncs land or fail to — so the marker has to follow it rather than
          // keep the opacity it was created with.
          existing.inner.style.opacity = vehicleOpacity(v);
        } else {
          // The API can return a different set of vehicle IDs after a poll.
          // Add new live trains without waiting for a map/style refresh.
          createVehicleMarker(v);
        }
      });
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
  };

  const applyLineFilter = (map, filter) => {
    const apply = () => {
      if (map.getLayer('metro-fill') && map.getLayer('metro-casing')) {
        const visibility = visibilityRef.current || {};
        const requestedLines = Array.isArray(filter) && filter.length > 0
          ? new Set(filter.map(String))
          : typeof filter === 'string' ? new Set([filter]) : null;
        const visible = lineFeatures
          .filter((feature) => feature.properties.mode === 'sbahn'
            ? visibility.sbahnLines !== false
            : visibility.ubahnLines !== false)
          .map((feature) => String(feature.properties.line))
          .filter((line) => !requestedLines || requestedLines.has(line));
        const expr = visible.length > 0
          ? ['any', ...visible.map((line) => ['==', ['get', 'line'], line])]
          : ['==', ['get', 'line'], '__hidden__'];
        map.setFilter('metro-fill', expr);
        map.setFilter('metro-casing', expr);

        if (map.getLayer('service-alert-line')) {
          const affected = new Set(disruptionsRef.current.flatMap((alert) => alert.lines || []));
          const alertedVisible = visible.filter((line) => affected.has(line));
          map.setFilter('service-alert-line', alertedVisible.length > 0
            ? ['any', ...alertedVisible.map((line) => ['==', ['get', 'line'], line])]
            : ['==', ['get', 'line'], '__no_active_alert__']);
        }

        // Compute side-by-side offsets when multiple lines are visible.
        // If no filter, reset offsets to 0.
        const spacing = (lineRenderConfig && Number.isFinite(lineRenderConfig.offsetSpacing)) ? lineRenderConfig.offsetSpacing : 6; // pixels
        const offsets = {};
        // Group visible lines by an approximate geometry key so identical/shared
        // geometries are not offset apart (they represent the same track).
        const geomKey = (id) => {
          const feat = lineFeatures.find(l => String(l.properties.line) === String(id));
          if (!feat || !feat.geometry || !feat.geometry.coordinates) return id;
          return feat.geometry.coordinates.map(c => `${c[0].toFixed(5)},${c[1].toFixed(5)}`).join('|');
        };
        const groups = {};
        visible.forEach(id => {
          const key = geomKey(id);
          groups[key] = groups[key] || [];
          groups[key].push(String(id));
        });
        // Standalone lines (like Line 4 running on its own dedicated tracks) MUST have offset 0
        // to prevent twisting, miter spikes, or self-intersecting loops on corners.
        // Only lines sharing the exact same track corridor receive a subtle side-by-side offset.
        for (const feat of lineFeatures) {
          offsets[String(feat.properties.line)] = 0;
        }
        for (const key of Object.keys(groups)) {
          const group = groups[key];
          if (group.length > 1) {
            for (let i = 0; i < group.length; i++) {
              const id = group[i];
              offsets[id] = (i - (group.length - 1) / 2) * Math.min(spacing, 4);
            }
          }
        }
        // apply offsets to features
        for (const feat of lineFeatures) {
          const id = String(feat.properties.line);
          feat.properties.offset = offsets[id] || 0;
        }
        // update source data so `line-offset` picks up new offsets
        const src = map.getSource('metro-lines');
        if (src && typeof src.setData === 'function') src.setData({ type: 'FeatureCollection', features: lineFeatures });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('styledata', apply);
  };

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: styleFor(theme),
      center: [16.3738, 48.2082],
      // 12.3 is where updateZoomScale's formula below caps marker scale at its
      // 1.2x maximum, so the default view opens with stations already at their
      // largest, easiest-to-tap size rather than the network's full extent.
      zoom: 11.4,
    });

    const trainCount = document.createElement('div');
    trainCount.className = 'line3-train-count glass-panel';
    trainCount.setAttribute('aria-live', 'polite');
    containerRef.current.appendChild(trainCount);
    trainCountRef.current = trainCount;
    updateTrainCount();
    mapRef.current = map;

    const updateZoomScale = () => {
      const zoom = map.getZoom();
      // At zoom 11.5 scale = 1.0, at zoom 9 scale ~0.5, at zoom 7.5 scale = 0 (fully hidden)
      const scale = Math.max(0.0, Math.min(1.2, (zoom - 7.5) / 4.0));
      applyMarkerScale(scale);
    };
    map.on('zoom', updateZoomScale);
    updateZoomScale();

    // A forgiving tap. This fires only for clicks that reach the map canvas —
    // a click that lands squarely on a Station marker is handled by the marker's
    // own handler and never gets here — so this is purely the near-miss case.
    map.on('click', (event) => {
      // Below this scale the Station markers are hidden, and nothing invisible
      // should be tappable.
      if (zoomScaleRef.current < 0.55) return;

      const { lng, lat } = event.lngLat;
      const nearest = nearestFeature(drawnStationsRef.current, [lng, lat]);
      if (!nearest) return;

      // The radius is a constant number of pixels — a finger is the same size at
      // every zoom — so it has to be converted into metres at the zoom in force.
      const radiusM = TAP_RADIUS_PX * metresPerPixel(lat, map.getZoom());
      if (nearest.distance > radiusM) return;

      selectStRef.current(nearest.feature);
    });

    map.on('style.load', () => {
      // In dev, StrictMode double-mounts this effect, so a stale map from the
      // first mount can still be sitting on a pending style.load when the
      // second mount replaces mapRef.current. The marker refs are shared
      // across instances, so letting a stale callback through would clear the
      // live map's markers and re-attach them to the removed one.
      if (mapRef.current !== map) return;
      initStationMarkers(map);
      initAlertMarkers(map);
      initVehicleLoop(map);
      applyLineFilter(map, filterRef.current);
      arrivalStore.syncNetwork();
    });

    // Predictions age out after about 18 minutes, so without a repeat sweep the
    // whole network quietly decays into simulated trains. Stations still inside
    // their memory pause cost nothing, so this is cheaper than it looks.
    const syncIfVisible = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      arrivalStore.syncNetwork();
    };
    const syncTimer = setInterval(syncIfVisible, NETWORK_SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', syncIfVisible);

    return () => {
      clearInterval(syncTimer);
      document.removeEventListener('visibilitychange', syncIfVisible);
      stopAnimation();
      clearVehicleMarkers();
      clearStationMarkers();
      clearAlertMarkers();
      trainCount.remove();
      trainCountRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // The map is constructed with the style matching the initial `theme`, so
    // this effect's mount-time run has nothing to do — and calling setStyle
    // before that initial style has loaded triggers a second style.load cycle
    // (and a "Style is not done loading" console warning) that only widens
    // the StrictMode double-mount race above. A theme flip that lands in that
    // narrow pre-load window is silently missed, which is an acceptable trade
    // for removing the race.
    if (!map.isStyleLoaded()) return;
    // diff:false because the two vector styles differ by more than paint: each
    // flavour names its own sprite file, and MapLibre's style diffing cannot
    // express a sprite change. Left to diff, a flip repainted some of the 56
    // basemap layers and not others, landing on a light ground wearing dark
    // labels. A full reload costs one re-read of the archive header and is the
    // only way to be sure the whole basemap changed.
    map.setStyle(styleFor(theme), { diff: false });
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTarget) return;
    const [lng, lat] = snappedCoordinates(flyTarget);
    map.flyTo({
      center: [lng, lat],
      zoom: 14.5,
      essential: true,
      duration: 1200,
    });
  }, [flyTarget]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyLineFilter(map, activeLineFilter);
    // Rebuild station markers to reflect the active line filter
    if (map.isStyleLoaded()) {
      initStationMarkers(map);
      initVehicleLoop(map);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLineFilter]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyLineFilter(map, filterRef.current);
    initStationMarkers(map);
    initAlertMarkers(map);
    initVehicleLoop(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapVisibility]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyLineFilter(map, filterRef.current);
    initAlertMarkers(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disruptions]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded()) initStationMarkers(map);
  }, [hoverLine]);

  // ── Station Focus ──────────────────────────────────────────────────────────
  // Clicking a Station does two things here: the camera eases in to centre it,
  // and its marker grows into a node showing both directions with the next
  // train on each. The node redraws every second so its countdowns tick.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    if (focusMarkerRef.current) {
      focusMarkerRef.current.remove();
      focusMarkerRef.current = null;
    }
    // The floating "N live trains" readout and the Station panel say the same
    // kind of thing at once — worse, the panel visually sits on top of it,
    // so the count peeked out from under the panel's corner. The panel is the
    // more specific answer while a Station is in focus.
    if (trainCountRef.current) {
      trainCountRef.current.style.visibility = selectedStation ? 'hidden' : '';
    }
    if (!selectedStation) return undefined;

    const coordinates = snappedCoordinates(selectedStation);

    const element = document.createElement('div');
    element.className = 'station-focus-node';
    const marker = new Marker({ element, anchor: 'bottom', offset: [0, -14] })
      .setLngLat(coordinates)
      .addTo(map);
    focusMarkerRef.current = marker;

    const render = () => {
      const focus = getStationFocus(selectedStation.properties, Date.now());
      element.innerHTML = renderFocusNode(focus, themeRef.current);
    };
    render();
    const id = setInterval(render, 1000);

    // The panel shares this render (same selectedStation update), so it is
    // already in the DOM once this effect runs and can be measured.
    const basePadding = panelAwarePadding(map);

    map.easeTo({
      center: coordinates,
      zoom: Math.max(map.getZoom(), STATION_FOCUS_ZOOM),
      padding: basePadding,
      duration: 900,
      essential: true,
    });

    return () => {
      clearInterval(id);
      marker.remove();
      if (focusMarkerRef.current === marker) focusMarkerRef.current = null;
    };
  }, [selectedStation]);

  // ── The viewer's own dot ───────────────────────────────────────────────────
  // A MapLibre Marker rather than a style layer, matching every other marker
  // here, which also means it survives the setStyle a theme flip performs.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !userLocation || userLocation.status !== 'located') return undefined;

    const wrapper = document.createElement('div');
    wrapper.className = 'user-location-marker';
    const accuracyRing = document.createElement('div');
    accuracyRing.className = 'user-location-accuracy';
    const dot = document.createElement('div');
    dot.className = 'user-location-dot';
    wrapper.appendChild(accuracyRing);
    wrapper.appendChild(dot);

    const marker = new Marker({ element: wrapper, anchor: 'center' })
      .setLngLat(userLocation.coordinates)
      .addTo(map);

    const sizeAccuracyRing = () => {
      if (!Number.isFinite(userLocation.accuracy)) {
        accuracyRing.style.display = 'none';
        return;
      }
      const scale = metresPerPixel(userLocation.coordinates[1], map.getZoom());
      const diameter = (2 * userLocation.accuracy) / scale;
      // Below the dot's own size the ring says nothing the dot does not already
      // say, and drawing it would only make a precise fix look fuzzy.
      accuracyRing.style.display = diameter < 26 ? 'none' : '';
      accuracyRing.style.width = `${diameter}px`;
      accuracyRing.style.height = `${diameter}px`;
    };

    const fade = () => {
      wrapper.style.opacity = userFixOpacity(Date.now() - userLocation.fetchedAt);
    };

    sizeAccuracyRing();
    fade();
    map.on('zoom', sizeAccuracyRing);
    // Five seconds is one hundredth of the fade's span, so the decay reads as
    // gradual without a second animation loop running against the vehicles'.
    const fadeTimer = setInterval(fade, 5000);

    return () => {
      map.off('zoom', sizeAccuracyRing);
      clearInterval(fadeTimer);
      marker.remove();
    };
  }, [userLocation]);

  // ── Framing the viewer against their Nearest Station ───────────────────────
  // Declared after the station-focus effect on purpose. A locate that names a
  // Station sets both `selectedStation` and `userLocation` in one commit, so
  // both effects run; React runs them in declaration order, and this one has to
  // be the camera call that lands. Seeing both points is the whole answer —
  // centring on the viewer alone says where you are but not how far the train
  // is.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !userLocation || userLocation.status !== 'located') return;

    const padding = panelAwarePadding(map);

    if (!userLocation.nearestStation) {
      // No Station worth naming — too rough a fix, or genuinely nothing near.
      // Being located is still useful, so the camera still goes there.
      map.easeTo({
        center: userLocation.coordinates,
        zoom: Math.max(map.getZoom(), 14.5),
        padding,
        duration: 900,
        essential: true,
      });
      return;
    }

    const bounds = new LngLatBounds(userLocation.coordinates, userLocation.coordinates);
    bounds.extend(snappedCoordinates(userLocation.nearestStation));
    map.fitBounds(bounds, {
      padding,
      maxZoom: USER_FRAME_MAX_ZOOM,
      duration: 900,
      essential: true,
    });
  }, [userLocation]);

  return (
    <div
      ref={containerRef}
      className="map-container"
      style={{ width: '100%', height: '100%' }}
    />
  );
};

export default MapView;
