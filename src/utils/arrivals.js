// Real-time Vienna U-Bahn integration with arrival memory and rate budgeting.
import metroData from '../data/metro_lines.json';
import arrivalStore, { STATION_ID_MAP } from '../services/arrivalStore';

export { STATION_ID_MAP, arrivalStore };

/**
 * Fetch real-time arrivals for a station using the Arrival Memory store.
 * Returns cached/projected countdowns immediately if fresh, avoiding redundant API calls.
 */
export const fetchRealStationArrivals = async (stationProps, options = {}) => {
  return arrivalStore.getStationArrivals(stationProps, options);
};

export const getStationArrivalsFallback = (stationProps) => {
  if (!stationProps) return [];
  
  const lines = stationProps.lines || [];
  const now = Date.now();
  const arrivals = [];

  lines.forEach((lineId) => {
    const lineFeature = metroData.features.find(
      f => f.properties.line === lineId && f.geometry.type === 'LineString'
    );
    const lineName = lineFeature ? lineFeature.properties.name : `Line ${lineId}`;
    const lineColor = lineFeature ? lineFeature.properties.color : '#8a8a8a';
    const destinations = lineFeature && Array.isArray(lineFeature.properties.terminals)
      ? lineFeature.properties.terminals
      : ['Terminus'];

    destinations.forEach((dest, i) => {
      const seed = (stationProps.name.length * 17 + lineId.charCodeAt(0) * 31 + i * 47) % 600000;
      const cycle = 480000; // 8 min cycle
      const elapsed = (now + seed) % cycle;
      const minutesRemaining = Math.max(1, Math.round((cycle - elapsed) / 60000));
      const secondsRemaining = minutesRemaining * 60;

      arrivals.push({
        line: lineId,
        lineName,
        lineColor,
        destination: dest,
        minutes: minutesRemaining,
        seconds: secondsRemaining,
        status: minutesRemaining <= 2 ? 'Approaching' : 'On Time',
        isLive: false
      });
    });
  });

  return arrivals.sort((a, b) => a.minutes - b.minutes);
};

export const getStationArrivals = getStationArrivalsFallback;
