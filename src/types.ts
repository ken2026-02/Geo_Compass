export interface Measurement {
  id: string;
  timestamp: number;
  dip: number;
  dipDirection: number;
  strike: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  note?: string;
  projectName: string;
  declination?: number;
  manualOffset?: number;
  confidenceScore?: number;
  confidenceLabel?: 'low' | 'medium' | 'high';
  trueNorthApplied?: boolean;
  declinationSource?: string;
}

export interface OrientationData {
  alpha: number | null; // z-axis (compass)
  beta: number | null;  // x-axis (pitch)
  gamma: number | null; // y-axis (roll)
  absolute: boolean;
}
