import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { connectSocket, disconnectSocket } from './lib/socket';
import { useTelemetryStore, useClaimsStore, useUIStore } from './stores';
import toast from 'react-hot-toast';

// Layouts
import WorkerLayout from './components/layouts/WorkerLayout';
import AdminLayout from './components/layouts/AdminLayout';

// Worker screens
import WorkerHome from './pages/worker/WorkerHome';
import TelemetrySimulator from './pages/worker/TelemetrySimulator';
import OnboardingFlow from './pages/worker/OnboardingFlow';
import ActiveCoverage from './pages/worker/ActiveCoverage';
import WeeklyPremium from './pages/worker/WeeklyPremium';
import ClaimHistory from './pages/worker/ClaimHistory';
import DisruptionAlerts from './pages/worker/DisruptionAlerts';
import ProfileSettings from './pages/worker/ProfileSettings';

// Admin screens
import LossRatioMonitor from './pages/admin/LossRatioMonitor';
import FraudHeatmap from './pages/admin/FraudHeatmap';
import WardRiskTable from './pages/admin/WardRiskTable';
import PredictiveClaimVol from './pages/admin/PredictiveClaimVol';
import PayoutVelocity from './pages/admin/PayoutVelocity';
import WorkerRegistry from './pages/admin/WorkerRegistry';

function App() {
  const updateRt = useTelemetryStore((s) => s.updateRt);
  const addAlert = useTelemetryStore((s) => s.addAlert);
  const updateClaim = useClaimsStore((s) => s.updateClaim);

  useEffect(() => {
    const socket = connectSocket(
      localStorage.getItem('grap_token') || undefined,
      'GIG_0001'
    );

    socket.on('RT_UPDATE', (data) => {
      updateRt(data);
    });

    socket.on('DISRUPTION_ALERT', (data) => {
      addAlert(data);
      if (data.level === 'CLAIM_INITIATED') {
        toast.error('🚨 Disruption Alert: Claim initiated!', { duration: 8000 });
      } else {
        toast('⚠️ Weather disruption warning in your zone', {
          icon: '🌧️',
          duration: 5000,
        });
      }
    });

    socket.on('CLAIM_STATE', (data) => {
      updateClaim(data.claim_id, { state: data.state, payout_amount: data.payout });
      toast.success(`Claim updated: ${data.state}`, { duration: 4000 });
    });

    return () => disconnectSocket();
  }, []);

  // Simulate RT_UPDATE every 5s for dev
  useEffect(() => {
    let i = 0;
    const scores = [0.3, 0.45, 0.55, 0.7, 0.78, 0.82, 0.87, 0.91, 0.85, 0.72, 0.6, 0.45];
    const interval = setInterval(() => {
      updateRt({
        score: scores[i % scores.length],
        zone: 'MUM_KURLA_W12',
        s2_cell: 'S2L13_19.0726_72.8793',
        timestamp: new Date().toISOString(),
      });
      i++;
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Routes>
      {/* Worker routes */}
      <Route path="/" element={<WorkerLayout />}>
        <Route index element={<WorkerHome />} />
        <Route path="simulator" element={<TelemetrySimulator />} />
        <Route path="onboarding" element={<OnboardingFlow />} />
        <Route path="coverage" element={<ActiveCoverage />} />
        <Route path="premium" element={<WeeklyPremium />} />
        <Route path="claims" element={<ClaimHistory />} />
        <Route path="alerts" element={<DisruptionAlerts />} />
        <Route path="settings" element={<ProfileSettings />} />
      </Route>

      {/* Admin routes */}
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<LossRatioMonitor />} />
        <Route path="fraud" element={<FraudHeatmap />} />
        <Route path="wards" element={<WardRiskTable />} />
        <Route path="predictions" element={<PredictiveClaimVol />} />
        <Route path="payouts" element={<PayoutVelocity />} />
        <Route path="workers" element={<WorkerRegistry />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
