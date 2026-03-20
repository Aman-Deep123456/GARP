import { useTelemetryStore } from '../../stores';
import { cn, riskColor, riskBgColor } from '../../lib/utils';
import { Shield, MapPin, Gauge, Activity } from 'lucide-react';

export default function ActiveCoverage() {
  const { rtScore, zone, s2Cell, speed, activity, gpsLocked } = useTelemetryStore();

  const getRiskLevel = () => {
    if (rtScore >= 0.85) return { label: 'CLAIM ELIGIBLE', color: 'text-red-400', bg: 'bg-red-500/20' };
    if (rtScore >= 0.6) return { label: 'ELEVATED RISK', color: 'text-amber-400', bg: 'bg-amber-500/20' };
    if (rtScore >= 0.3) return { label: 'MODERATE', color: 'text-yellow-400', bg: 'bg-yellow-500/20' };
    return { label: 'SAFE ZONE', color: 'text-emerald-400', bg: 'bg-emerald-500/20' };
  };

  const risk = getRiskLevel();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold flex items-center gap-2">
        <Shield className="w-5 h-5 text-primary" />
        Active Coverage
      </h1>

      {/* Live Rt Gauge */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="text-center mb-6">
          <p className="text-[10px] uppercase text-muted-foreground">Live Risk Score</p>
          <p className={cn('text-5xl font-bold font-mono mt-2', riskColor(rtScore))}>
            {rtScore.toFixed(3)}
          </p>
          <span className={cn('inline-block mt-2 px-3 py-1 rounded-full text-xs font-semibold', risk.bg, risk.color)}>
            {risk.label}
          </span>
        </div>

        {/* Gauge bar */}
        <div className="relative h-4 bg-muted rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full risk-gauge-fill',
            rtScore > 0.85 ? 'bg-gradient-to-r from-amber-500 to-red-500' :
            rtScore > 0.6 ? 'bg-gradient-to-r from-yellow-500 to-amber-500' :
            'bg-gradient-to-r from-emerald-500 to-yellow-500'
          )} style={{ width: `${rtScore * 100}%` }} />
          {/* Threshold marker at 0.85 */}
          <div className="absolute top-0 bottom-0 w-0.5 bg-red-500" style={{ left: '85%' }} />
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
          <span>0.00</span><span>0.30</span><span>0.60</span><span className="text-red-400">0.85</span><span>1.00</span>
        </div>
      </div>

      {/* Status grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
          <MapPin className="w-5 h-5 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">GPS Status</p>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={cn('w-2 h-2 rounded-full', gpsLocked ? 'bg-emerald-500 animate-pulse' : 'bg-red-500')} />
              <span className="text-sm font-medium">{gpsLocked ? 'Locked' : 'No Fix'}</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
          <Gauge className="w-5 h-5 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Speed</p>
            <p className="text-sm font-bold mt-1">{speed.toFixed(1)} km/h</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
          <Activity className="w-5 h-5 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Activity</p>
            <span className="text-xs font-medium px-2 py-0.5 bg-primary/10 text-primary rounded-full mt-1 inline-block">{activity}</span>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
          <Shield className="w-5 h-5 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">S2 Cell</p>
            <p className="text-[10px] font-mono mt-1 break-all">{s2Cell || '—'}</p>
          </div>
        </div>
      </div>

      {/* Zone info */}
      <div className={cn('rounded-xl border border-border bg-card p-4', riskBgColor(rtScore))}>
        <p className="text-xs text-muted-foreground">Current Ward Zone</p>
        <p className="text-sm font-bold mt-1">{zone || 'Scanning...'}</p>
        <p className="text-[10px] text-muted-foreground mt-1">
          {rtScore > 0.85
            ? '⚠️ Risk threshold exceeded — claim gate timer active'
            : 'Coverage active — monitoring environmental conditions'}
        </p>
      </div>
    </div>
  );
}
