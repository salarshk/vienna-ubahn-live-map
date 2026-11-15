// Curated public road cameras with a verified relationship to a U-Bahn station.
// The ITS Vienna Region viewer is a road view, not station surveillance. Keep
// this list explicit so the UI never implies that one camera covers every stop.
const ITS_VIEWER_BASE = 'https://cam1.its-viennaregion.at/itswebcamviewer/SingleScreen.aspx';

const camera = (id, label) => ({
  id,
  label,
  url: `${ITS_VIEWER_BASE}?camname=${id}&noITS=true`,
});

export const CAMERA_DIRECTORY_URL = 'https://www.wien.gv.at/verkehr/verkehrslage';

export const VERIFIED_STATION_CAMERAS = Object.freeze({
  'Schönbrunn': [camera('itscam20', 'Schlossallee · Linke Wienzeile')],
  'Kagran': [camera('itscam21', 'Wagramer Straße · Donaustadtstraße')],
  'Handelskai': [
    camera('itscam42', 'Handelskai · southbound'),
    camera('itscam43', 'Handelskai · northbound'),
  ],
  'Altes Landgut': [camera('itscam54', 'Grenzackerstraße · Verteilerkreis')],
});

const STATION_ALIASES = Object.freeze({
  'Schoenbrunn': 'Schönbrunn',
  'Kagraner Platz': 'Kagran',
  'Altes Landgut': 'Altes Landgut',
});

export const getStationCameras = (stationName) => {
  const name = String(stationName || '').trim();
  return VERIFIED_STATION_CAMERAS[name]
    || VERIFIED_STATION_CAMERAS[STATION_ALIASES[name]]
    || [];
};

export default getStationCameras;
