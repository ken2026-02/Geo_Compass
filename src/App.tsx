import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Compass,
  Download,
  History,
  Layers,
  Lock,
  MapPin,
  Plus,
  Save,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unlock,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Measurement, OrientationData } from './types';
import { estimateOfflineDeclination } from './declination';
import {
  computeOrientation,
  scoreMeasurementConfidence,
  type ConfidenceWindowSample,
  type MeasurementConfidence,
} from './orientation';
import { loadPersistedState, persistState } from './storage';

const DEFAULT_PROJECT = 'Default Project';
const MAX_RECENT_MEASUREMENTS = 6;
const SIGNAL_STALE_MS = 3500;

type SensorState = 'idle' | 'live' | 'stale';

function formatDegree(value: number) {
  return `${Math.round(value)}°`;
}

function formatQuadrant(azimuth: number) {
  const deg = ((azimuth % 360) + 360) % 360;
  if (deg <= 90) return `N${Math.round(deg)}°E`;
  if (deg <= 180) return `S${Math.round(180 - deg)}°E`;
  if (deg <= 270) return `S${Math.round(deg - 180)}°W`;
  return `N${Math.round(360 - deg)}°W`;
}

function getDipQuadrant(dipDir: number) {
  const deg = ((dipDir % 360) + 360) % 360;
  if (deg > 337.5 || deg <= 22.5) return 'N';
  if (deg <= 67.5) return 'NE';
  if (deg <= 112.5) return 'E';
  if (deg <= 157.5) return 'SE';
  if (deg <= 202.5) return 'S';
  if (deg <= 247.5) return 'SW';
  if (deg <= 292.5) return 'W';
  return 'NW';
}

function statusTone(status: SensorState) {
  if (status === 'live') return 'bg-emerald-500';
  if (status === 'stale') return 'bg-amber-500';
  return 'bg-slate-500';
}

const Stereonet = ({ dip, dipDir }: { dip: number; dipDir: number }) => {
  const radius = (Math.max(0, Math.min(dip, 90)) / 90) * 38;
  const angle = ((dipDir - 90) * Math.PI) / 180;
  const x = radius * Math.cos(angle) || 0;
  const y = radius * Math.sin(angle) || 0;

  return (
    <div className="relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-black/35">
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="h-full w-px bg-white/5" />
        <div className="h-px w-full bg-white/5" />
        <div className="h-14 w-14 rounded-full border border-white/5" />
      </div>
      <motion.div
        className="z-10 h-2.5 w-2.5 rounded-full bg-[#ff8a3d] shadow-[0_0_10px_rgba(255,138,61,0.65)]"
        animate={{ x, y }}
        transition={{ type: 'spring', stiffness: 120, damping: 14 }}
      />
      <div className="absolute top-1 text-[8px] font-mono uppercase tracking-[0.18em] text-white/50">N</div>
    </div>
  );
};

const Pill = ({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) => (
  <div className="rounded-2xl border border-black/8 bg-white/70 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
    <div className="text-[9px] font-mono uppercase tracking-[0.22em] text-black/45">{label}</div>
    <div className={`mt-1 font-semibold text-black/85 ${compact ? 'text-[13px]' : 'text-sm'}`}>{value}</div>
  </div>
);

export default function App() {
  const [orientation, setOrientation] = useState<OrientationData>({ alpha: 0, beta: 0, gamma: 0, absolute: false });
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [projects, setProjects] = useState<string[]>([DEFAULT_PROJECT]);
  const [currentProject, setCurrentProject] = useState(DEFAULT_PROJECT);
  const [newProjectName, setNewProjectName] = useState('');
  const [permissionStatus, setPermissionStatus] = useState<'prompt' | 'granted' | 'denied'>('prompt');
  const [location, setLocation] = useState<{ lat: number; lon: number; alt: number | null } | null>(null);
  const [declination, setDeclination] = useState(0);
  const [declinationSource, setDeclinationSource] = useState('manual');
  const [declinationConfidence, setDeclinationConfidence] = useState<'high' | 'medium' | 'low'>('low');
  const [manualOffset, setManualOffset] = useState(0);
  const [useTrueNorth, setUseTrueNorth] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [isPersisted, setIsPersisted] = useState(false);
  const [sensorError, setSensorError] = useState(false);
  const [sensorState, setSensorState] = useState<SensorState>('idle');
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showBottomMeta, setShowBottomMeta] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<MeasurementConfidence>({
    score: 0,
    label: 'low',
    reasons: ['Not enough samples'],
    canRecord: false,
  });
  const [dip, setDip] = useState(0);
  const [dipDir, setDipDir] = useState(0);
  const [strike, setStrike] = useState(0);

  const lastUpdateTime = useRef(0);
  const lastSignalAt = useRef(0);
  const calibrationTimeoutRef = useRef<number | null>(null);
  const deleteTimeoutRef = useRef<number | null>(null);
  const recentSamplesRef = useRef<ConfidenceWindowSample[]>([]);

  const tiltMagnitude = useMemo(() => {
    const beta = orientation.beta || 0;
    const gamma = orientation.gamma || 0;
    return Math.sqrt(beta * beta + gamma * gamma);
  }, [orientation.beta, orientation.gamma]);

  const holdQuality = tiltMagnitude < 2 ? 'Excellent' : tiltMagnitude < 6 ? 'Good' : 'Moving';

  const handleOrientation = useCallback(
    (event: DeviceOrientationEvent & { webkitCompassHeading?: number | null }) => {
      if (isLocked) return;
      if (event.alpha === null && event.beta === null && event.gamma === null) {
        setSensorError(true);
        setSensorState('stale');
        return;
      }

      setSensorError(false);
      setSensorState('live');
      lastSignalAt.current = Date.now();

      const computed = computeOrientation(
        {
          alpha: event.alpha,
          beta: event.beta,
          gamma: event.gamma,
          absolute: !!event.absolute,
          webkitCompassHeading: event.webkitCompassHeading,
        },
        declination,
        manualOffset,
        useTrueNorth,
      );

      if (!computed) {
        setSensorError(true);
        return;
      }

      const previous = recentSamplesRef.current[recentSamplesRef.current.length - 1];
      const headingJump = previous ? Math.abs(computed.headingMagnetic - previous.heading) : 0;
      if (headingJump > 12) {
        setIsCalibrating(true);
        if (calibrationTimeoutRef.current !== null) window.clearTimeout(calibrationTimeoutRef.current);
        calibrationTimeoutRef.current = window.setTimeout(() => setIsCalibrating(false), 2200);
      }

      const now = Date.now();
      if (now - lastUpdateTime.current < 50) return;
      lastUpdateTime.current = now;

      const nextSample: ConfidenceWindowSample = {
        timestamp: now,
        heading: computed.headingMagnetic,
        dip: computed.dip,
        dipDirection: computed.dipDirection,
        beta: event.beta || 0,
        gamma: event.gamma || 0,
      };

      recentSamplesRef.current = [...recentSamplesRef.current.filter((sample) => now - sample.timestamp < 2500), nextSample];

      const nextConfidence = scoreMeasurementConfidence({
        samples: recentSamplesRef.current,
        sensorFreshMs: 0,
        sensorError: false,
        isCalibrating,
        absolute: computed.absolute,
        declinationConfidence,
      });

      setConfidence(nextConfidence);
      setDip(Math.round(computed.dip) || 0);
      setDipDir(Math.round(computed.dipDirection) || 0);
      setStrike(Math.round(computed.strike) || 0);
      setOrientation({
        alpha: computed.headingCorrected || 0,
        beta: event.beta || 0,
        gamma: event.gamma || 0,
        absolute: computed.absolute,
      });
    },
    [declination, declinationConfidence, isCalibrating, isLocked, manualOffset, useTrueNorth],
  );

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      const state = await loadPersistedState([DEFAULT_PROJECT]);
      if (cancelled) return;

      setMeasurements(state.measurements);
      setProjects(state.projects.length ? state.projects : [DEFAULT_PROJECT]);
      setIsPersisted(state.storageMode === 'indexeddb');
      if (state.measurements[0]) setLastSavedAt(state.measurements[0].timestamp);
      if (state.restoredFromBackup) {
        setRestoreNotice('Recovered offline records from backup snapshot.');
      } else if (state.storageMode === 'legacy') {
        setRestoreNotice('Migrated existing offline records into the new storage engine.');
      }
    }

    hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projects.includes(currentProject)) setCurrentProject(projects[0] ?? DEFAULT_PROJECT);
  }, [projects, currentProject]);

  useEffect(() => {
    let cancelled = false;
    async function save() {
      const ok = await persistState(measurements, projects);
      if (!cancelled) {
        setStorageWarning(ok ? null : 'Offline database unavailable. Using backup snapshot only.');
        setIsPersisted(ok);
      }
    }
    save();
    return () => {
      cancelled = true;
    };
  }, [measurements, projects]);

  useEffect(() => {
    if (permissionStatus !== 'granted') return undefined;
    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, [permissionStatus, handleOrientation]);

  useEffect(() => {
    if (permissionStatus !== 'granted') return undefined;
    const timer = window.setInterval(() => {
      const freshMs = lastSignalAt.current ? Date.now() - lastSignalAt.current : SIGNAL_STALE_MS + 1;
      if (!lastSignalAt.current) {
        setSensorState('idle');
      } else {
        setSensorState(freshMs > SIGNAL_STALE_MS ? 'stale' : 'live');
      }

      setConfidence(
        scoreMeasurementConfidence({
          samples: recentSamplesRef.current,
          sensorFreshMs: freshMs,
          sensorError,
          isCalibrating,
          absolute: orientation.absolute,
          declinationConfidence,
        }),
      );
    }, 800);
    return () => window.clearInterval(timer);
  }, [declinationConfidence, isCalibrating, orientation.absolute, permissionStatus, sensorError]);

  useEffect(() => {
    if (!location) return;
    const estimate = estimateOfflineDeclination(location.lat, location.lon);
    setDeclination(estimate.declination);
    setDeclinationConfidence(estimate.confidence);
    setDeclinationSource(estimate.source);
  }, [location]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setSensorState('idle');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    return () => {
      if (calibrationTimeoutRef.current !== null) window.clearTimeout(calibrationTimeoutRef.current);
      if (deleteTimeoutRef.current !== null) window.clearTimeout(deleteTimeoutRef.current);
    };
  }, []);

  const requestPermission = async () => {
    try {
      const requestPermissionFn = (
        window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
          requestPermission?: () => Promise<string>;
        }
      ).requestPermission;

      if (typeof requestPermissionFn === 'function') {
        const response = await requestPermissionFn();
        if (response !== 'granted') {
          setPermissionStatus('denied');
          return;
        }
      }

      setPermissionStatus('granted');

      if (navigator.storage?.persist) {
        const persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
        setIsPersisted(persisted);
      }

      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (position) =>
            setLocation({
              lat: position.coords.latitude,
              lon: position.coords.longitude,
              alt: position.coords.altitude,
            }),
          () => undefined,
          { enableHighAccuracy: false, maximumAge: 600000, timeout: 8000 },
        );
      }
    } catch {
      setPermissionStatus('denied');
    }
  };

  const addProject = () => {
    const normalized = newProjectName.trim();
    if (!normalized) return;
    if (!projects.includes(normalized)) setProjects((prev) => [...prev, normalized]);
    setCurrentProject(normalized);
    setNewProjectName('');
  };

  const saveMeasurement = () => {
    if (!confidence.canRecord) return;

    const entry: Measurement = {
      id:
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      dip,
      dipDirection: dipDir,
      strike,
      latitude: location?.lat,
      longitude: location?.lon,
      altitude: location?.alt || undefined,
      projectName: currentProject,
      declination,
      manualOffset,
      confidenceScore: confidence.score,
      confidenceLabel: confidence.label,
      trueNorthApplied: useTrueNorth,
      declinationSource,
    };
    setMeasurements((prev) => [entry, ...prev]);
    setLastSavedAt(entry.timestamp);
    setPendingDeleteId(null);
  };

  const deleteMeasurement = (id: string) => {
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      if (deleteTimeoutRef.current !== null) window.clearTimeout(deleteTimeoutRef.current);
      deleteTimeoutRef.current = window.setTimeout(() => setPendingDeleteId(null), 2800);
      return;
    }
    setMeasurements((prev) => prev.filter((item) => item.id !== id));
    setPendingDeleteId(null);
  };

  const exportData = () => {
    if (!measurements.length) return;
    const rows = [
      ['ID', 'Timestamp', 'Project', 'Dip', 'DipDirection', 'Strike', 'Lat', 'Lon', 'Alt', 'Declination', 'Offset', 'Confidence', 'NorthMode', 'DeclinationSource'],
      ...measurements.map((item) => [
        item.id,
        new Date(item.timestamp).toISOString(),
        item.projectName,
        item.dip,
        item.dipDirection,
        item.strike,
        item.latitude ?? '',
        item.longitude ?? '',
        item.altitude ?? '',
        item.declination ?? 0,
        item.manualOffset ?? 0,
        item.confidenceLabel ?? '',
        item.trueNorthApplied ? 'true' : 'magnetic',
        item.declinationSource ?? '',
      ]),
    ];
    const blob = new Blob([rows.map((row) => row.join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `geocompass_export_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const recentMeasurements = measurements.slice(0, MAX_RECENT_MEASUREMENTS);

  if (permissionStatus === 'prompt' || permissionStatus === 'denied') {
    return (
      <div className="flex min-h-screen items-center justify-center px-5 py-10 text-white">
        <div className="w-full max-w-md overflow-hidden rounded-[34px] border border-white/10 bg-[#101217]/85 shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur">
          <div className="relative px-6 pb-8 pt-10">
            <div className="absolute inset-x-0 top-0 h-40 bg-[radial-gradient(circle_at_top,rgba(255,138,61,0.38),transparent_62%)]" />
            <div className="relative flex justify-center">
              <div className="flex h-22 w-22 items-center justify-center rounded-full border border-white/15 bg-[#ff8a3d] p-6 shadow-[0_0_40px_rgba(255,138,61,0.4)]">
                <Compass size={40} className="text-white" />
              </div>
            </div>
            <div className="relative mt-6 text-center">
              <div className="text-[10px] font-mono uppercase tracking-[0.3em] text-white/45">Field Ready Compass</div>
              <h1 className="mt-3 font-serif text-4xl font-bold italic tracking-tight text-white">GeoCompass Pro</h1>
              <p className="mt-4 text-sm leading-relaxed text-slate-300">
                Single-screen field capture for dip, dip direction, and strike. Enable motion sensors once, then use it
                offline on mobile.
              </p>
              {permissionStatus === 'denied' ? (
                <div className="mt-4 flex items-center justify-center gap-2 rounded-2xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                  <AlertCircle size={14} />
                  Sensor access denied. Check browser site settings and try again.
                </div>
              ) : null}
            </div>
            <button
              onClick={requestPermission}
              className="relative mt-8 w-full rounded-2xl bg-white py-4 text-xs font-bold uppercase tracking-[0.32em] text-black transition hover:bg-[#ff8a3d] hover:text-white"
            >
              Initialize Sensors
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-[#17181b]">
      <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col px-3 pb-40 pt-3">
        <header className="sticky top-0 z-30 rounded-[30px] border border-black/8 bg-[rgba(247,242,233,0.82)] px-4 py-4 shadow-[0_10px_30px_rgba(68,55,34,0.08)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="rounded-full bg-[#17181b] p-2 text-white shadow-[0_10px_24px_rgba(23,24,27,0.18)]">
                  <Compass size={16} />
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.28em] text-black/40">Geo Field Tool</div>
                  <div className="font-serif text-lg font-bold italic text-black/90">GeoCompass Pro</div>
                </div>
              </div>
            </div>
            <div className="rounded-full border border-black/8 bg-white/75 px-3 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${statusTone(sensorState)}`} />
                <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-black/55">{sensorState}</span>
              </div>
            </div>
          </div>

        </header>

        <main className="mt-3 space-y-3">
          {restoreNotice ? (
            <div className="flex items-center gap-2 rounded-[24px] border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-900">
              <ShieldCheck size={15} className="shrink-0" />
              <span>{restoreNotice}</span>
            </div>
          ) : null}

          {storageWarning ? (
            <div className="flex items-center gap-2 rounded-[24px] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-900">
              <AlertTriangle size={16} className="shrink-0" />
              <span>{storageWarning}</span>
            </div>
          ) : null}

          {sensorError ? (
            <div className="flex items-center gap-2 rounded-[24px] border border-red-500/25 bg-red-500/10 px-4 py-3 text-xs text-red-800">
              <AlertTriangle size={16} className="shrink-0" />
              <span>Device sensors are not returning usable data. This tool needs a compass and gyroscope to measure reliably.</span>
            </div>
          ) : null}

          {isCalibrating ? (
            <div className="flex items-center gap-2 rounded-[24px] border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs font-mono uppercase tracking-[0.18em] text-amber-900">
              <AlertTriangle size={14} className="shrink-0" />
              <span>Magnetic interference detected. Hold steady and recalibrate.</span>
            </div>
          ) : null}

          <section className="relative overflow-hidden rounded-[30px] bg-[#101218] px-3.5 pb-4 pt-3.5 text-white shadow-[0_24px_60px_rgba(16,18,24,0.34)]">
            <div className="absolute inset-x-0 top-0 h-32 bg-[radial-gradient(circle_at_top,rgba(255,138,61,0.28),transparent_62%)]" />
            <div className="relative">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.28em] text-white/45">Live Reading</div>
                  <div className="mt-2 text-sm text-white/65">
                    {holdQuality} hold · {isLocked ? 'Locked capture' : 'Live tracking'}
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-right">
                  <div className="text-[9px] font-mono uppercase tracking-[0.22em] text-white/45">Confidence</div>
                  <div className="mt-1 text-sm font-semibold text-white">{confidence.label}</div>
                </div>
              </div>

              <div className="relative mt-4 flex justify-center py-1">
                <div className="absolute left-0 top-1/2 h-36 w-2 -translate-y-1/2 overflow-hidden rounded-full border border-white/5 bg-white/5">
                  <motion.div
                    className={`absolute h-12 w-full ${Math.abs(orientation.beta || 0) < 1 ? 'bg-emerald-500' : 'bg-[#ff8a3d]'}`}
                    animate={{ y: `${50 + (orientation.beta || 0) * 0.5}%`, top: '-24px' }}
                    transition={{ type: 'spring', stiffness: 100, damping: 15 }}
                  />
                  <div className="absolute top-1/2 h-px w-full bg-white/25" />
                </div>

                <div className="absolute left-1/2 top-0 h-2 w-36 -translate-x-1/2 overflow-hidden rounded-full border border-white/5 bg-white/5">
                  <motion.div
                    className={`absolute h-full w-12 ${Math.abs(orientation.gamma || 0) < 1 ? 'bg-emerald-500' : 'bg-[#ff8a3d]'}`}
                    animate={{ x: `${50 + (orientation.gamma || 0) * 0.5}%`, left: '-24px' }}
                    transition={{ type: 'spring', stiffness: 100, damping: 15 }}
                  />
                  <div className="absolute left-1/2 h-full w-px bg-white/25" />
                </div>

                <div className="relative flex h-46 w-46 items-center justify-center rounded-full border border-dashed border-white/15">
                  <motion.div
                    className="absolute inset-0 rounded-full border border-white/10"
                    animate={{ rotate: -(orientation.alpha || 0) }}
                    transition={{ type: 'spring', stiffness: 50, damping: 18 }}
                  >
                    {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
                      <div key={deg} className="absolute inset-0 flex justify-center" style={{ transform: `rotate(${deg}deg)` }}>
                        <div className={`mt-1 w-px ${deg % 90 === 0 ? 'h-3 bg-white/45' : 'h-1.5 bg-white/20'}`} />
                        {deg % 90 === 0 ? (
                          <span className="absolute mt-4 text-[8px] font-bold uppercase tracking-[0.18em] text-white/55">
                            {deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : 'W'}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </motion.div>

                  <div className="relative flex h-32 w-32 items-center justify-center overflow-hidden rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.08),transparent_55%),linear-gradient(180deg,#1e232d_0%,#141820_100%)] shadow-[inset_0_16px_30px_rgba(255,255,255,0.04),inset_0_-20px_30px_rgba(0,0,0,0.35)]">
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="h-8 w-8 rounded-full border border-white/10" />
                      <div className="h-16 w-16 rounded-full border border-white/5" />
                      <div className="absolute h-px w-full bg-white/5" />
                      <div className="absolute h-full w-px bg-white/5" />
                    </div>
                    <motion.div
                      className={`h-8 w-8 rounded-full blur-[1px] ${
                        Math.abs(orientation.beta || 0) < 1 && Math.abs(orientation.gamma || 0) < 1
                          ? 'bg-emerald-500 shadow-[0_0_24px_rgba(16,185,129,0.55)]'
                          : 'bg-[#ff8a3d] shadow-[0_0_24px_rgba(255,138,61,0.45)]'
                      }`}
                      animate={{ x: (orientation.gamma || 0) * 1.4, y: (orientation.beta || 0) * 1.4 }}
                      transition={{ type: 'spring', stiffness: 150, damping: 20 }}
                    />
                    <div className="absolute bottom-3 flex gap-2 text-[8px] font-mono text-white/45">
                      <span>X {formatDegree(orientation.gamma || 0)}</span>
                      <span>Y {formatDegree(orientation.beta || 0)}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <div className="rounded-[24px] border border-white/10 bg-white/5 p-3.5">
                  <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-white/45">Dip Direction</div>
                  <div className="mt-2 flex items-end gap-1 font-serif text-[2.6rem] italic leading-none">
                    <span>{dipDir.toString().padStart(3, '0')}</span>
                    <span className="pb-1 text-base text-[#ff8a3d]">°</span>
                  </div>
                  <div className="mt-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-white/60">{getDipQuadrant(dipDir)}</div>
                </div>

                <div className="rounded-[24px] border border-white/10 bg-white/5 p-3.5">
                  <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-white/45">Dip Angle</div>
                  <div className="mt-2 flex items-end gap-1 font-serif text-[2.6rem] italic leading-none">
                    <span>{dip.toString().padStart(2, '0')}</span>
                    <span className="pb-1 text-base text-[#ff8a3d]">°</span>
                  </div>
                  <div className="mt-1.5 text-[11px] font-mono uppercase tracking-[0.18em] text-white/60">{holdQuality} hold</div>
                </div>
              </div>

              <div className="mt-2.5 flex items-center justify-between rounded-[24px] border border-white/10 bg-white/5 p-3.5">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-white/45">Strike</div>
                  <div className="mt-1.5 flex items-end gap-1 font-serif text-[2.2rem] italic leading-none">
                    <span>{strike.toString().padStart(3, '0')}</span>
                    <span className="pb-1 text-sm text-[#ff8a3d]">°</span>
                  </div>
                  <div className="mt-1.5 text-[10px] font-mono uppercase tracking-[0.16em] text-white/60">{formatQuadrant(strike)}</div>
                </div>
                <Stereonet dip={dip} dipDir={dipDir} />
              </div>
            </div>
          </section>

          <section className="rounded-[30px] border border-black/8 bg-[rgba(255,255,255,0.58)] p-4 shadow-[0_16px_40px_rgba(74,58,32,0.08)] backdrop-blur-xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-black/45">Capture</div>
                <div className="mt-1 text-sm font-semibold text-black/85">Ready to store the current reading</div>
              </div>
              <button
                onClick={() => setShowSettings((prev) => !prev)}
                className="rounded-2xl border border-black/8 bg-white/70 p-3 text-black/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]"
              >
                <Settings2 size={18} />
              </button>
            </div>

            <AnimatePresence initial={false}>
              {showSettings ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-4 space-y-3 border-t border-black/8 pt-4">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-2xl border border-black/8 bg-white/70 px-3 py-3">
                        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-black/45">Declination</div>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={declination}
                          onChange={(event) => {
                            setDeclination(Number(event.target.value));
                            setDeclinationSource('manual');
                            setDeclinationConfidence('high');
                          }}
                          className="mt-1 w-full bg-transparent text-sm font-semibold text-black/80 outline-none"
                        />
                      </div>
                      <div className="rounded-2xl border border-black/8 bg-white/70 px-3 py-3">
                        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-black/45">Manual Offset</div>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={manualOffset}
                          onChange={(event) => setManualOffset(Number(event.target.value))}
                          className="mt-1 w-full bg-transparent text-sm font-semibold text-black/80 outline-none"
                        />
                      </div>
                    </div>

                    <div className="rounded-2xl border border-black/8 bg-white/70 px-3 py-3">
                      <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-black/45">Compass Setup</div>
                      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                        <select
                          value={currentProject}
                          onChange={(event) => setCurrentProject(event.target.value)}
                          className="w-full bg-transparent text-sm font-semibold text-black/80 outline-none"
                        >
                          {projects.map((project) => (
                            <option key={project} value={project}>
                              {project}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => setUseTrueNorth((prev) => !prev)}
                          className="rounded-xl border border-black/8 bg-white px-3 py-2 text-xs font-bold uppercase tracking-[0.14em] text-black/75"
                        >
                          {useTrueNorth ? 'True' : 'Mag'}
                        </button>
                      </div>
                      <div className="mt-2 text-xs text-black/55">
                        Declination {declination.toFixed(1)}° · {declinationSource} · {declinationConfidence} confidence
                      </div>
                    </div>

                    <div className="rounded-2xl border border-black/8 bg-white/70 px-3 py-3">
                      <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-black/45">Add Project</div>
                      <div className="mt-2 flex gap-2">
                        <input
                          type="text"
                          value={newProjectName}
                          onChange={(event) => setNewProjectName(event.target.value)}
                          placeholder="New project name"
                          className="min-w-0 flex-1 rounded-xl border border-black/8 bg-white px-3 py-2 text-sm outline-none"
                        />
                        <button
                          onClick={addProject}
                          className="flex items-center gap-1 rounded-xl bg-[#17181b] px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-white"
                        >
                          <Plus size={14} />
                          Add
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl border border-black/8 bg-white/70 px-3 py-3">
                      <div>
                        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-black/45">Export</div>
                        <div className="mt-1 text-xs text-black/60">Download all local measurements to CSV.</div>
                      </div>
                      <button
                        onClick={exportData}
                        disabled={measurements.length === 0}
                        className="flex items-center gap-2 rounded-xl bg-[#17181b] px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-white disabled:opacity-40"
                      >
                        <Download size={14} />
                        CSV
                      </button>
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </section>

          <section className="rounded-[30px] border border-black/8 bg-[rgba(255,255,255,0.58)] p-4 shadow-[0_16px_40px_rgba(74,58,32,0.08)] backdrop-blur-xl">
            <button className="flex w-full items-center justify-between" onClick={() => setShowHistory((prev) => !prev)}>
              <div className="text-left">
                <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-black/45">Recent Measurements</div>
                <div className="mt-1 text-sm font-semibold text-black/85">{measurements.length} records stored locally</div>
              </div>
              {showHistory ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>

            <AnimatePresence initial={false}>
              {showHistory ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-4 space-y-2">
                    {recentMeasurements.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-black/10 bg-white/40 px-4 py-8 text-center text-sm text-black/45">
                        No measurements recorded yet.
                      </div>
                    ) : (
                      recentMeasurements.map((measurement) => (
                        <div
                          key={measurement.id}
                          className="rounded-[24px] border border-black/8 bg-white/72 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-serif text-xl font-bold italic text-black/88">
                                {formatDegree(measurement.dipDirection)} / {formatDegree(measurement.dip)}
                              </div>
                              <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-black/45">
                                {measurement.projectName} · {new Date(measurement.timestamp).toLocaleString()}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-black/60">
                                <span className="rounded-full bg-[#f5f1e7] px-2.5 py-1">Strike {formatDegree(measurement.strike)}</span>
                                {measurement.latitude !== undefined && measurement.longitude !== undefined ? (
                                  <span className="rounded-full bg-[#f5f1e7] px-2.5 py-1">
                                    {measurement.latitude.toFixed(4)}, {measurement.longitude.toFixed(4)}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <button
                              onClick={() => deleteMeasurement(measurement.id)}
                              className={`rounded-xl px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] transition ${
                                pendingDeleteId === measurement.id
                                  ? 'bg-red-600 text-white'
                                  : 'bg-white text-red-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]'
                              }`}
                            >
                              <span className="flex items-center gap-1.5">
                                <Trash2 size={12} />
                                {pendingDeleteId === measurement.id ? 'Confirm' : 'Delete'}
                              </span>
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </section>
        </main>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-lg px-3 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        <div className="space-y-2 rounded-[28px] border border-black/8 bg-[rgba(23,24,27,0.88)] p-3 shadow-[0_18px_50px_rgba(0,0,0,0.35)] backdrop-blur-xl">
          <div className="flex items-center justify-between px-1">
            <button
              onClick={() => setShowBottomMeta((prev) => !prev)}
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/6 px-3 py-2 text-[10px] font-mono uppercase tracking-[0.2em] text-white/70"
            >
              <Layers size={12} />
              {showBottomMeta ? 'Hide Info' : 'Show Info'}
            </button>
          </div>

          <AnimatePresence initial={false}>
            {showBottomMeta ? (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="rounded-[24px] border border-white/8 bg-white/6 p-2.5">
                  <div className="grid grid-cols-2 gap-2">
                    <Pill label="Project" value={currentProject} />
                    <Pill label="Last Save" value={lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : 'Not yet'} />
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2">
                    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/80 px-3 py-2 text-[10px] font-mono uppercase tracking-[0.18em] text-black/60">
                      {isPersisted ? <ShieldCheck size={14} className="text-emerald-700" /> : <ShieldAlert size={14} className="text-amber-700" />}
                      <span>{isPersisted ? 'Pinned Local Data' : 'Temporary Local Data'}</span>
                    </div>
                    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/80 px-3 py-2 text-[10px] font-mono uppercase tracking-[0.18em] text-black/60">
                      <Layers size={14} className="text-[#c86d2b]" />
                      <span>{useTrueNorth ? 'True North' : 'Magnetic North'}</span>
                    </div>
                    {location ? (
                      <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/80 px-3 py-2 text-[10px] font-mono uppercase tracking-[0.18em] text-black/60">
                        <MapPin size={14} className="text-[#c86d2b]" />
                        <span>
                          {location.lat.toFixed(4)}, {location.lon.toFixed(4)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
            <button
              onClick={() => setIsLocked((prev) => !prev)}
              className={`flex h-14 w-14 items-center justify-center rounded-2xl transition ${
                isLocked ? 'bg-[#ff8a3d] text-white' : 'bg-white/10 text-white'
              }`}
            >
              {isLocked ? <Lock size={18} /> : <Unlock size={18} />}
            </button>

            <button
              onClick={saveMeasurement}
              disabled={!confidence.canRecord}
              className="flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#ff8a3d_0%,#f26b2c_100%)] px-5 py-3 text-sm font-bold uppercase tracking-[0.18em] text-white shadow-[0_14px_30px_rgba(242,107,44,0.35)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Save size={16} />
              {confidence.canRecord ? 'Record Measurement' : 'Hold For Stable Fix'}
            </button>

            <button
              onClick={() => setShowHistory((prev) => !prev)}
              className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-white"
            >
              <History size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
