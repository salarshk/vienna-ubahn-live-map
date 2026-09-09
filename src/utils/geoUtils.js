// Helper functions for geospatial calculations along polylines

// Haversine distance in meters between two [lon, lat] points
export const getDistance = (p1, p2) => {
  const R = 6371000; // Earth radius in meters
  const dLat = ((p2[1] - p1[1]) * Math.PI) / 180;
  const dLon = ((p2[0] - p1[0]) * Math.PI) / 180;
  const lat1 = (p1[1] * Math.PI) / 180;
  const lat2 = (p2[1] * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const polylineCache = new WeakMap();

const getPolylineDistances = (coords) => {
  if (polylineCache.has(coords)) {
    return polylineCache.get(coords);
  }

  const cumulative = [0];
  let total = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const dist = getDistance(coords[i], coords[i + 1]);
    total += dist;
    cumulative.push(total);
  }

  const result = { cumulative, total };
  polylineCache.set(coords, result);
  return result;
};

// Fast binary-search polyline interpolation given progress t from 0 to 1
export const interpolatePath = (coords, t) => {
  if (!coords || coords.length === 0) return [0, 0];
  if (coords.length === 1) return coords[0];

  const progress = Math.max(0, Math.min(1, t));
  const { cumulative, total } = getPolylineDistances(coords);

  if (total === 0) return coords[0];

  const targetDist = progress * total;

  // Binary search for the segment
  let low = 0;
  let high = cumulative.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] <= targetDist) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const idx = Math.max(0, high);
  if (idx >= coords.length - 1) return coords[coords.length - 1];

  const segStartDist = cumulative[idx];
  const segEndDist = cumulative[idx + 1];
  const segLen = segEndDist - segStartDist;

  const segProgress = segLen > 0 ? (targetDist - segStartDist) / segLen : 0;
  const p1 = coords[idx];
  const p2 = coords[idx + 1];

  return [
    p1[0] + (p2[0] - p1[0]) * segProgress,
    p1[1] + (p2[1] - p1[1]) * segProgress
  ];
};

// The point on a polyline closest to a given point, with how far off it was.
//
// Works in a local flat projection centred on the query point rather than in
// degrees: longitude and latitude have different scales, so treating lon/lat
// as a plane without that correction
// biases every answer eastward. Over a segment a few hundred metres long the
// flat approximation is otherwise exact to well under a metre.
//
// Returns null for a path with nothing to project onto.
export const nearestPointOnPath = (coords, point) => {
  if (!coords || coords.length === 0 || !point) return null;
  if (coords.length === 1) {
    return { coordinates: coords[0].slice(), distance: getDistance(point, coords[0]) };
  }

  const metresPerLon = Math.cos((point[1] * Math.PI) / 180) * 111320;
  const metresPerLat = 110540;
  const toLocal = (c) => [(c[0] - point[0]) * metresPerLon, (c[1] - point[1]) * metresPerLat];

  let best = null;

  for (let i = 0; i < coords.length - 1; i++) {
    const a = toLocal(coords[i]);
    const b = toLocal(coords[i + 1]);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;

    // Where along this segment the perpendicular from the point lands, clamped
    // to the segment so a point beside the line's end snaps to the end rather
    // than to an imaginary continuation of it.
    const t = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / lengthSquared));

    const closest = [a[0] + dx * t, a[1] + dy * t];
    const distance = Math.hypot(closest[0], closest[1]);

    if (!best || distance < best.distance) {
      best = {
        distance,
        coordinates: [
          point[0] + closest[0] / metresPerLon,
          point[1] + closest[1] / metresPerLat,
        ],
      };
    }
  }

  return best;
};

// The feature nearest a coordinate, with how far away it was.
//
// Policy-free on purpose: it names the nearest whatever the distance, and the
// caller decides whether that is close enough to mean anything. Nearest-wins is
// what makes a forgiving tap target safe — where two stations' targets overlap,
// the one you were actually closest to is the one you get, rather than whichever
// happened to be drawn on top.
export const nearestFeature = (features, coordinates) => {
  if (!features || features.length === 0 || !coordinates) return null;

  let best = null;
  for (const feature of features) {
    const distance = getDistance(coordinates, feature.geometry.coordinates);
    if (!best || distance < best.distance) best = { feature, distance };
  }

  return best;
};
