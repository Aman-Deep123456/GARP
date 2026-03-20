import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workerAPI } from '../../lib/api';
import { cn } from '../../lib/utils';
import toast from 'react-hot-toast';
import { Settings, Shield, Trash2, Pause, Play, Moon, Sun, Lock } from 'lucide-react';
import { useUIStore } from '../../stores';

export default function ProfileSettings() {
  const { darkMode, toggleDarkMode } = useUIStore();
  const [telemetryPaused, setTelemetryPaused] = useState(false);

  const { data: worker, isLoading } = useQuery({
    queryKey: ['worker', 'GIG_0001'],
    queryFn: () => workerAPI.get('GIG_0001').then((r) => r.data),
  });

  const handlePauseTelemetry = async () => {
    try {
      await workerAPI.updateSettings('GIG_0001', { telemetry_paused: !telemetryPaused });
      setTelemetryPaused(!telemetryPaused);
      toast.success(telemetryPaused ? 'Telemetry resumed' : 'Telemetry paused');
    } catch {
      toast.error('Failed to update settings');
    }
  };

  const handleErasure = async () => {
    if (!confirm('Request data erasure? This will delete all your personal data within 72 hours (DPDPA Article 12).')) return;
    try {
      await workerAPI.updateSettings('GIG_0001', { erasure_requested: true });
      toast.success('Erasure request submitted — will be processed within 72 hours');
    } catch {
      toast.error('Failed to submit erasure request');
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold flex items-center gap-2">
        <Settings className="w-5 h-5 text-primary" /> Profile & Settings
      </h1>

      {/* Profile card */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-[10px] uppercase text-muted-foreground mb-3">Profile</p>
        {isLoading ? (
          <div className="space-y-2">
            <div className="skeleton h-5 w-40 rounded" />
            <div className="skeleton h-4 w-32 rounded" />
          </div>
        ) : (
          <div className="space-y-2">
            {[
              ['Name', worker?.name],
              ['Worker ID', worker?.worker_id],
              ['Phone', worker?.phone],
              ['Platform', worker?.platform],
              ['Ward', worker?.ward_id],
              ['Vehicle', worker?.vehicle_type],
              ['Tenure', `${worker?.tenure_weeks} weeks`],
            ].map(([label, value]) => (
              <div key={label as string} className="flex justify-between text-sm">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="rounded-xl border border-border bg-card divide-y divide-border">
        {/* Dark mode */}
        <button onClick={toggleDarkMode} className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-3">
            {darkMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            <span className="text-sm">Dark Mode</span>
          </div>
          <div className={cn('w-10 h-6 rounded-full transition-colors relative', darkMode ? 'bg-primary' : 'bg-muted')}>
            <div className={cn('w-4 h-4 rounded-full bg-white absolute top-1 transition-all', darkMode ? 'left-5' : 'left-1')} />
          </div>
        </button>

        {/* Telemetry pause */}
        <button onClick={handlePauseTelemetry} className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-3">
            {telemetryPaused ? <Pause className="w-4 h-4 text-amber-400" /> : <Play className="w-4 h-4 text-emerald-400" />}
            <div className="text-left">
              <span className="text-sm">Telemetry Collection</span>
              <p className="text-[10px] text-muted-foreground">{telemetryPaused ? 'Paused — coverage inactive' : 'Active — GPS data collected'}</p>
            </div>
          </div>
          <div className={cn('w-10 h-6 rounded-full transition-colors relative', !telemetryPaused ? 'bg-primary' : 'bg-muted')}>
            <div className={cn('w-4 h-4 rounded-full bg-white absolute top-1 transition-all', !telemetryPaused ? 'left-5' : 'left-1')} />
          </div>
        </button>
      </div>

      {/* Privacy section */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-semibold">Privacy (DPDPA 2023)</span>
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          <p>• Raw GPS deleted after claim + 7 days</p>
          <p>• Accelerometer data never persisted</p>
          <p>• Location anonymized to S2 Level 10 (~24km²)</p>
          <p>• k-anonymity k=5 on published records</p>
        </div>
        <button
          onClick={handleErasure}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-red-500/30 text-red-400 text-xs font-medium hover:bg-red-500/10 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" /> Request Data Erasure (Article 12)
        </button>
      </div>
    </div>
  );
}
