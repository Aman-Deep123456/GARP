import { create } from 'zustand';

// ── Types ────────────────────────────────────────────
export interface WorkerProfile {
  worker_id: string;
  name: string;
  phone: string;
  email?: string;
  platform: string;
  ward_id: string;
  city: string;
  vehicle_type: string;
  tenure_weeks: number;
  policy: {
    active: boolean;
    weekly_premium: number;
    sum_insured: number;
    start_date: string;
    end_date: string;
  };
  telemetry_paused: boolean;
}

export interface Claim {
  claim_id: string;
  worker_id: string;
  ward_id: string;
  state: string;
  risk_score: number;
  payout_amount?: number;
  hours_disrupted?: number;
  fraud_verdict?: string;
  fraud_score?: number;
  settled_at?: string;
  rejected_at?: string;
  created_at: string;
  transitions: Array<{ from: string; to: string; timestamp: string; reason?: string }>;
}

export interface RtUpdate {
  score: number;
  zone: string;
  s2_cell?: string;
  timestamp: string;
}

export interface DisruptionAlert {
  level: 'WARNING' | 'CLAIM_INITIATED';
  timestamp: string;
  details?: Record<string, unknown>;
}

// ── Worker Store ─────────────────────────────────────
interface WorkerState {
  worker: WorkerProfile | null;
  token: string | null;
  isAuthenticated: boolean;
  setWorker: (worker: WorkerProfile, token: string) => void;
  logout: () => void;
}

export const useWorkerStore = create<WorkerState>((set) => ({
  worker: null,
  token: localStorage.getItem('grap_token'),
  isAuthenticated: !!localStorage.getItem('grap_token'),
  setWorker: (worker, token) => {
    localStorage.setItem('grap_token', token);
    set({ worker, token, isAuthenticated: true });
  },
  logout: () => {
    localStorage.removeItem('grap_token');
    set({ worker: null, token: null, isAuthenticated: false });
  },
}));

// ── Telemetry Store ──────────────────────────────────
interface TelemetryState {
  rtScore: number;
  zone: string;
  s2Cell: string;
  speed: number;
  activity: string;
  gpsLocked: boolean;
  isSimulating: boolean;
  alerts: DisruptionAlert[];
  updateRt: (update: RtUpdate) => void;
  updateTelemetry: (data: Partial<TelemetryState>) => void;
  addAlert: (alert: DisruptionAlert) => void;
  clearAlerts: () => void;
  setSimulating: (v: boolean) => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  rtScore: 0,
  zone: '',
  s2Cell: '',
  speed: 0,
  activity: 'STILL',
  gpsLocked: false,
  isSimulating: false,
  alerts: [],
  updateRt: (update) =>
    set({ rtScore: update.score, zone: update.zone, s2Cell: update.s2_cell || '' }),
  updateTelemetry: (data) => set((s) => ({ ...s, ...data })),
  addAlert: (alert) => set((s) => ({ alerts: [alert, ...s.alerts].slice(0, 20) })),
  clearAlerts: () => set({ alerts: [] }),
  setSimulating: (v) => set({ isSimulating: v }),
}));

// ── Claims Store ─────────────────────────────────────
interface ClaimsState {
  claims: Claim[];
  setClaims: (claims: Claim[]) => void;
  updateClaim: (claimId: string, update: Partial<Claim>) => void;
  addClaim: (claim: Claim) => void;
}

export const useClaimsStore = create<ClaimsState>((set) => ({
  claims: [],
  setClaims: (claims) => set({ claims }),
  updateClaim: (claimId, update) =>
    set((s) => ({
      claims: s.claims.map((c) => (c.claim_id === claimId ? { ...c, ...update } : c)),
    })),
  addClaim: (claim) => set((s) => ({ claims: [claim, ...s.claims] })),
}));

// ── UI Store ─────────────────────────────────────────
interface UIState {
  darkMode: boolean;
  sidebarOpen: boolean;
  activeView: 'worker' | 'admin';
  toggleDarkMode: () => void;
  toggleSidebar: () => void;
  setActiveView: (view: 'worker' | 'admin') => void;
}

export const useUIStore = create<UIState>((set) => ({
  darkMode: true,
  sidebarOpen: true,
  activeView: 'worker',
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      document.documentElement.classList.toggle('dark', next);
      return { darkMode: next };
    }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setActiveView: (view) => set({ activeView: view }),
}));
