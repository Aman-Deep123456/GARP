import { useTelemetryStore } from '../../stores';
import { cn, relativeTime } from '../../lib/utils';
import { AlertTriangle, Bell, BellOff } from 'lucide-react';

export default function DisruptionAlerts() {
  const { alerts, clearAlerts, rtScore } = useTelemetryStore();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-primary" /> Disruption Alerts
        </h1>
        {alerts.length > 0 && (
          <button onClick={clearAlerts} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Clear all
          </button>
        )}
      </div>

      {/* Live warning banner */}
      {rtScore > 0.85 && (
        <div className="disruption-banner rounded-xl bg-red-500/20 border border-red-500/30 p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-500/30 flex items-center justify-center animate-pulse">
            <AlertTriangle className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-red-400">ACTIVE DISRUPTION</p>
            <p className="text-xs text-muted-foreground">Risk score {rtScore.toFixed(3)} exceeds claim threshold (0.85)</p>
          </div>
        </div>
      )}

      {rtScore > 0.6 && rtScore <= 0.85 && (
        <div className="disruption-banner rounded-xl bg-amber-500/20 border border-amber-500/30 p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-500/30 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-amber-400">WEATHER WARNING</p>
            <p className="text-xs text-muted-foreground">Elevated environmental risk in your zone</p>
          </div>
        </div>
      )}

      {/* Alert history */}
      {alerts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <BellOff className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No active alerts</p>
          <p className="text-xs text-muted-foreground mt-1">You'll be notified when disruptions affect coverage</p>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map((alert, i) => (
            <div
              key={i}
              className={cn(
                'rounded-xl border p-3.5 flex items-center gap-3',
                alert.level === 'CLAIM_INITIATED'
                  ? 'border-red-500/30 bg-red-500/10'
                  : 'border-amber-500/30 bg-amber-500/10'
              )}
            >
              <Bell className={cn('w-4 h-4 shrink-0',
                alert.level === 'CLAIM_INITIATED' ? 'text-red-400' : 'text-amber-400'
              )} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold">
                  {alert.level === 'CLAIM_INITIATED' ? '🚨 Claim Initiated' : '⚠️ Weather Warning'}
                </p>
                <p className="text-[10px] text-muted-foreground" title={alert.timestamp}>
                  {relativeTime(alert.timestamp)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
