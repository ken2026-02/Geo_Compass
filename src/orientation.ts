export interface OrientationSampleInput {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean;
  webkitCompassHeading?: number | null;
}

export interface OrientationComputation {
  headingMagnetic: number;
  headingCorrected: number;
  dip: number;
  dipDirection: number;
  strike: number;
  tiltMagnitude: number;
  absolute: boolean;
}

export interface ConfidenceWindowSample {
  timestamp: number;
  heading: number;
  dip: number;
  dipDirection: number;
  beta: number;
  gamma: number;
}

export interface MeasurementConfidence {
  score: number;
  label: 'low' | 'medium' | 'high';
  reasons: string[];
  canRecord: boolean;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function normalizeDegrees(value: number) {
  return ((value % 360) + 360) % 360;
}

function angleDelta(a: number, b: number) {
  let diff = normalizeDegrees(a) - normalizeDegrees(b);
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

function quaternionMultiply(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

function quaternionConjugate([w, x, y, z]: [number, number, number, number]): [number, number, number, number] {
  return [w, -x, -y, -z];
}

function rotateVector(
  quaternion: [number, number, number, number],
  vector: [number, number, number],
): [number, number, number] {
  const vectorQuat: [number, number, number, number] = [0, vector[0], vector[1], vector[2]];
  const rotated = quaternionMultiply(quaternionMultiply(quaternion, vectorQuat), quaternionConjugate(quaternion));
  return [rotated[1], rotated[2], rotated[3]];
}

export function eulerToQuaternion(alpha: number, beta: number, gamma: number): [number, number, number, number] {
  const halfZ = toRadians(alpha) / 2;
  const halfX = toRadians(beta) / 2;
  const halfY = toRadians(gamma) / 2;

  const qz: [number, number, number, number] = [Math.cos(halfZ), 0, 0, Math.sin(halfZ)];
  const qx: [number, number, number, number] = [Math.cos(halfX), Math.sin(halfX), 0, 0];
  const qy: [number, number, number, number] = [Math.cos(halfY), 0, Math.sin(halfY), 0];

  return quaternionMultiply(quaternionMultiply(qz, qx), qy);
}

export function computeCompassHeading(alpha: number, beta: number, gamma: number) {
  const alphaRad = toRadians(alpha);
  const betaRad = toRadians(beta);
  const gammaRad = toRadians(gamma);

  const cA = Math.cos(alphaRad);
  const sA = Math.sin(alphaRad);
  const sB = Math.sin(betaRad);
  const sG = Math.sin(gammaRad);
  const cB = Math.cos(betaRad);
  const cG = Math.cos(gammaRad);

  const vX = -cA * sG - sA * sB * cG;
  const vY = -sA * sG + cA * sB * cG;
  const heading = Math.atan2(vX, vY);
  return normalizeDegrees(toDegrees(heading));
}

export function computeOrientation(
  input: OrientationSampleInput,
  declination: number,
  manualOffset: number,
  useTrueNorth: boolean,
): OrientationComputation | null {
  if (input.alpha === null || input.beta === null || input.gamma === null) {
    return null;
  }

  const alpha = input.alpha || 0;
  const beta = input.beta || 0;
  const gamma = input.gamma || 0;
  const quaternion = eulerToQuaternion(alpha, beta, gamma);

  // Browser device coordinates use +Z out of the screen. For field capture we
  // treat the phone back as the plane normal, so rotate device -Z into ENU space.
  let normal = rotateVector(quaternion, [0, 0, -1]);
  if (normal[2] < 0) {
    normal = [-normal[0], -normal[1], -normal[2]];
  }

  const horizontal = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1]);
  const dip = toDegrees(Math.atan2(horizontal, Math.max(normal[2], 1e-6)));
  const dipDirection = horizontal > 1e-6 ? normalizeDegrees(toDegrees(Math.atan2(normal[0], normal[1]))) : 0;

  const headingMagnetic =
    input.webkitCompassHeading !== undefined && input.webkitCompassHeading !== null
      ? normalizeDegrees(input.webkitCompassHeading)
      : computeCompassHeading(alpha, beta, gamma);

  const headingCorrected = useTrueNorth
    ? normalizeDegrees(headingMagnetic + declination + manualOffset)
    : normalizeDegrees(headingMagnetic + manualOffset);

  return {
    headingMagnetic,
    headingCorrected,
    dip,
    dipDirection,
    strike: normalizeDegrees(dipDirection - 90),
    tiltMagnitude: Math.sqrt(beta * beta + gamma * gamma),
    absolute: input.absolute,
  };
}

function standardDeviation(values: number[]) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function circularStdDev(values: number[]) {
  if (values.length <= 1) return 0;
  const deltas = values.slice(1).map((value, index) => angleDelta(value, values[index]));
  return standardDeviation(deltas);
}

export function scoreMeasurementConfidence(params: {
  samples: ConfidenceWindowSample[];
  sensorFreshMs: number;
  sensorError: boolean;
  isCalibrating: boolean;
  absolute: boolean;
  declinationConfidence: 'high' | 'medium' | 'low';
}) {
  const { samples, sensorFreshMs, sensorError, isCalibrating, absolute, declinationConfidence } = params;
  const reasons: string[] = [];
  let score = 1;

  if (sensorError) {
    reasons.push('Sensor unavailable');
    score -= 0.7;
  }

  if (sensorFreshMs > 3000) {
    reasons.push('Signal stale');
    score -= 0.35;
  } else if (sensorFreshMs > 1200) {
    reasons.push('Signal aging');
    score -= 0.15;
  }

  if (isCalibrating) {
    reasons.push('Magnetic interference');
    score -= 0.35;
  }

  if (!absolute) {
    reasons.push('Non-absolute compass frame');
    score -= 0.2;
  }

  if (declinationConfidence === 'low') {
    reasons.push('Approximate offline declination');
    score -= 0.18;
  } else if (declinationConfidence === 'medium') {
    reasons.push('Regional declination estimate');
    score -= 0.08;
  }

  if (samples.length >= 3) {
    const headingStd = circularStdDev(samples.map((sample) => sample.heading));
    const dipStd = standardDeviation(samples.map((sample) => sample.dip));
    const dipDirStd = circularStdDev(samples.map((sample) => sample.dipDirection));
    const tiltStd = standardDeviation(
      samples.map((sample) => Math.sqrt(sample.beta * sample.beta + sample.gamma * sample.gamma)),
    );

    if (headingStd > 8) {
      reasons.push('Heading drift high');
      score -= 0.28;
    } else if (headingStd > 4) {
      reasons.push('Heading drift moderate');
      score -= 0.12;
    }

    if (dipStd > 4 || dipDirStd > 8) {
      reasons.push('Device still moving');
      score -= 0.22;
    } else if (dipStd > 2 || dipDirStd > 4) {
      reasons.push('Hold not settled');
      score -= 0.1;
    }

    if (tiltStd > 5) {
      reasons.push('Tilt instability');
      score -= 0.12;
    }
  } else {
    reasons.push('Not enough samples');
    score -= 0.18;
  }

  const normalized = Math.max(0, Math.min(1, score));
  const label = normalized >= 0.8 ? 'high' : normalized >= 0.62 ? 'medium' : 'low';

  return {
    score: normalized,
    label,
    reasons,
    canRecord: normalized >= 0.64 && !sensorError && sensorFreshMs <= 2500,
  } satisfies MeasurementConfidence;
}
