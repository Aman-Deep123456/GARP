import { useState, useEffect, useCallback } from 'react';
import { useTelemetryStore } from '../../stores';
import { telemetryAPI } from '../../lib/api';
import { cn, riskColor } from '../../lib/utils';
import toast from 'react-hot-toast';
import { Radio, Navigation, Activity, Gauge, Play, Square } from 'lucide-react';

function getActivityFromSpeed(speed: number): { type: string; confidence: number } {
  if (speed < 0.5) return { type: 'STILL', confidence: 95 };
  if (speed < 5) return { type: 'ON_FOOT', confidence: 80 };
  if (speed < 15) return { type: 'CYCLING', confidence: 85 };
  return { type: 'IN_VEHICLE', confidence: 90 };
}

export default function TelemetrySimulator() {
  const { rtScore, zone, s2Cell, speed, activity, gpsLocked, isSimulating, updateTelemetry, setSimulating } = useTelemetryStore();
  const [lat, setLat] = useState(19.0726);
  const [lng, setLng] = useState(72.8793);
  const [pingCount, setPingCount] = useState(0);

  const sendPing = useCallback(async () => {
    const currentSpeed = 2 + Math.random() * 20;
    const activityData = getActivityFromSpeed(currentSpeed);

    const payload = {
      worker_id: 'GIG_0001',
      timestamp: new Date().toISOString(),
      location: {
        latitude: lat + (Math.random() - 0.5) * 0.001,
        longitude: lng + (Math.random() - 0.5) * 0.001,
        accuracy: 3 + Math.random() * 10,
        speed: currentSpeed,
      },
      activity: activityData,
      accelerometer: {
        x: (Math.random() - 0.5) * 2,
        y: 9.8 + (Math.random() - 0.5) * 0.5,
        z: (Math.random() - 0.5) * 2,
      },
    };

    try {
      await telemetryAPI.post(payload);
      updateTelemetry({
        speed: currentSpeed,
        activity: activityData.type,
        gpsLocked: true,
      });
      setPingCount((p) => p + 1);
    } catch (err) {
      toast.error('Failed to send telemetry');
    }
  }, [lat, lng, updateTelemetry]);

  useEffect(() => {
    if (!isSimulating) return;
    sendPing();
    const interval = setInterval(sendPing, 30000);
    return () => clearInterval(interval);
  }, [isSimulating, sendPing]);

  // Try browser geolocation
  useEffect(() => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLat(pos.coords.latitude);
          setLng(pos.coords.longitude);
          updateTelemetry({ gpsLocked: true });
        },
        () => updateTelemetry({ gpsLocked: false }),
        { enableHighAccuracy: true }
      );
    }
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold flex items-center gap-2">
        <Radio className="w-5 h-5 text-primary" />
        Telemetry Simulator
      </h1>

      {/* Status card */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] uppercase text-muted-foreground mb-1">GPS Lock</p>
            <div className="flex items-center gap-2">
              <span className={cn('w-2.5 h-2.5 rounded-full', gpsLocked ? 'bg-emerald-500 animate-pulse' : 'bg-red-500')} />
              <span className="text-sm font-medium">{gpsLocked ? 'Locked' : 'No Fix'}</span>
            </div>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground mb-1">S2 Cell ID</p>
            <p className="text-xs font-mono truncate">{s2Cell || 'Scanning...'}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground mb-1">Speed</p>
            <p className="text-sm font-bold">{speed.toFixed(1)} km/h</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground mb-1">Activity</p>
            <span className="text-xs font-medium px-2 py-0.5 bg-primary/10 text-primary rounded-full">{activity}</span>
          </div>
        </div>

        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase text-muted-foreground">Rt Score</span>
            <span className={cn('text-sm font-bold font-mono', riskColor(rtScore))}>{rtScore.toFixed(3)}</span>
          </div>
          <div className="h-3 bg-muted rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full risk-gauge-fill',
                rtScore > 0.85 ? 'bg-red-500' : rtScore > 0.6 ? 'bg-amber-500' : rtScore > 0.3 ? 'bg-yellow-500' : 'bg-emerald-500'
              )}
              style={{ width: `${Math.min(rtScore * 100, 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
            <span>Safe</span><span>Warning</span><span>Claim</span>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex gap-3">
        <button
          onClick={() => setSimulating(!isSimulating)}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all',
            isSimulating
              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
              : 'bg-primary text-primary-foreground hover:opacity-90'
          )}
        >
          {isSimulating ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          {isSimulating ? 'Stop Simulation' : 'Start Simulation'}
        </button>
      </div>

      {/* Stats */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-[10px] uppercase text-muted-foreground mb-2">Session Stats</p>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-lg font-bold">{pingCount}</p>
            <p className="text-[10px] text-muted-foreground">Pings Sent</p>
          </div>
          <div>
            <p className="text-lg font-bold">{zone.split('_').pop() || '—'}</p>
            <p className="text-[10px] text-muted-foreground">Zone</p>
          </div>
          <div>
            <p className="text-lg font-bold">{(pingCount * 30 / 60).toFixed(0)}m</p>
            <p className="text-[10px] text-muted-foreground">Duration</p>
          </div>
        </div>
      </div>
    </div>
  );
}
