export interface DeclinationReference {
  lat: number;
  lon: number;
  declination: number;
}

const OFFLINE_DECLINATION_POINTS: DeclinationReference[] = [
  { lat: -44.0, lon: 147.0, declination: 15.2 },
  { lat: -38.0, lon: 145.0, declination: 13.4 },
  { lat: -33.9, lon: 151.2, declination: 12.8 },
  { lat: -27.5, lon: 153.0, declination: 11.2 },
  { lat: -19.3, lon: 146.8, declination: 8.5 },
  { lat: -12.5, lon: 130.9, declination: 4.1 },
  { lat: -31.9, lon: 115.9, declination: -0.4 },
  { lat: -20.7, lon: 117.2, declination: 0.7 },
  { lat: -23.7, lon: 133.9, declination: 5.3 },
  { lat: -34.9, lon: 138.6, declination: 8.3 },
  { lat: -42.9, lon: 147.3, declination: 14.7 },
  { lat: -45.9, lon: 170.5, declination: 24.0 },
  { lat: -41.3, lon: 174.8, declination: 22.5 },
  { lat: -36.9, lon: 174.8, declination: 20.4 },
  { lat: -9.4, lon: 147.2, declination: 8.8 },
  { lat: 1.3, lon: 103.8, declination: 0.3 },
  { lat: 3.1, lon: 101.7, declination: 0.6 },
  { lat: 13.8, lon: 100.5, declination: 0.2 },
  { lat: 21.0, lon: 105.8, declination: -0.4 },
  { lat: 14.6, lon: 121.0, declination: -0.7 },
  { lat: 35.7, lon: 139.7, declination: -7.4 },
  { lat: 34.7, lon: 135.5, declination: -7.8 },
  { lat: 37.6, lon: 127.0, declination: -8.8 },
  { lat: 39.9, lon: 116.4, declination: -7.2 },
  { lat: 22.3, lon: 114.2, declination: -2.2 },
  { lat: 25.0, lon: 121.5, declination: -4.2 },
  { lat: 28.6, lon: 77.2, declination: 0.5 },
  { lat: 19.1, lon: 72.9, declination: 0.2 },
  { lat: 12.9, lon: 77.6, declination: -0.3 },
  { lat: 6.9, lon: 79.9, declination: -0.2 },
  { lat: 24.9, lon: 67.0, declination: 1.2 },
  { lat: 25.2, lon: 55.3, declination: 2.4 },
  { lat: -33.9, lon: 18.4, declination: -25.4 },
  { lat: -26.2, lon: 28.0, declination: -19.8 },
  { lat: 51.5, lon: -0.1, declination: 1.1 },
  { lat: 40.7, lon: -74.0, declination: -12.6 },
  { lat: 34.1, lon: -118.2, declination: 11.3 },
  { lat: 49.3, lon: -123.1, declination: 15.8 },
  { lat: 64.1, lon: -21.9, declination: -12.9 },
];

function normalizeLon(lon: number) {
  let next = lon;
  while (next < -180) next += 360;
  while (next > 180) next -= 360;
  return next;
}

function angularDistance(a: number, b: number) {
  const diff = Math.abs(normalizeLon(a) - normalizeLon(b));
  return Math.min(diff, 360 - diff);
}

function squaredDistanceKm(latA: number, lonA: number, latB: number, lonB: number) {
  const latScale = 111.32;
  const lonScale = 111.32 * Math.cos((((latA + latB) / 2) * Math.PI) / 180);
  const dLat = (latA - latB) * latScale;
  const dLon = angularDistance(lonA, lonB) * lonScale;
  return dLat * dLat + dLon * dLon;
}

export function estimateOfflineDeclination(lat: number, lon: number) {
  const normalizedLon = normalizeLon(lon);
  const nearest = OFFLINE_DECLINATION_POINTS
    .map((point) => ({
      ...point,
      distanceSq: squaredDistanceKm(lat, normalizedLon, point.lat, point.lon),
    }))
    .sort((a, b) => a.distanceSq - b.distanceSq)
    .slice(0, 4);

  if (!nearest.length) {
    return {
      declination: 0,
      confidence: 'low' as const,
      source: 'offline-regional-table',
    };
  }

  if (nearest[0].distanceSq < 1) {
    return {
      declination: nearest[0].declination,
      confidence: 'high' as const,
      source: 'offline-regional-table',
    };
  }

  let weightSum = 0;
  let declinationSum = 0;

  for (const point of nearest) {
    const weight = 1 / Math.max(point.distanceSq, 25);
    weightSum += weight;
    declinationSum += point.declination * weight;
  }

  const distanceKm = Math.sqrt(nearest[0].distanceSq);
  const confidence = distanceKm < 250 ? 'high' : distanceKm < 700 ? 'medium' : 'low';

  return {
    declination: declinationSum / weightSum,
    confidence,
    source: 'offline-regional-table',
  };
}
