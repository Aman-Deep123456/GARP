import { useQuery } from '@tanstack/react-query';
import { workerAPI, claimsAPI } from '../../lib/api';
import { useTelemetryStore } from '../../stores';
import { formatINR, relativeTime, riskColor, riskBgColor, stateBadgeColor, cn } from '../../lib/utils';
import { Shield, TrendingUp, Wallet, AlertTriangle, Clock } from 'lucide-react';

export default function WorkerHome() {
  const rtScore = useTelemetryStore((s) => s.rtScore);
  const zone = useTelemetryStore((s) => s.zone);

  const { data: worker, isLoading: wLoading } = useQuery({
    queryKey: ['worker', 'GIG_0001'],
    queryFn: () => workerAPI.get('GIG_0001').then((r) => r.data),
  });

  const { data: claimsData, isLoading: cLoading } = useQuery({
    queryKey: ['claims', 'GIG_0001'],
    queryFn: () => claimsAPI.getByWorker('GIG_0001').then((r) => r.data),
  });

  const claims = claimsData?.claims || [];
  const settled = claims.filter((c: any) => c.state === 'SETTLED');
  const totalProtected = settled.reduce((sum: number, c: any) => sum + (c.payout_amount || 0), 0);

  return (
    <div className="space-y-4 animate-slide-up">
      {/* Hero card */}
      <div className="rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-700 p-5 text-white">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-5 h-5" />
          <span className="text-sm font-medium opacity-90">Earnings Protected</span>
        </div>
        {wLoading ? (
          <div className="skeleton h-10 w-48 bg-white/20 rounded mt-2" />
        ) : (
          <p className="text-3xl font-bold">{formatINR(totalProtected)}</p>
        )}
        <p className="text-xs opacity-75 mt-1">Lifetime payouts received</p>
      </div>

      {/* Live status cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Risk Score</span>
          </div>
          <p className={cn('text-2xl font-bold font-mono', riskColor(rtScore))}>
            {rtScore.toFixed(2)}
          </p>
          <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
            <div className={cn('h-full rounded-full risk-gauge-fill',
              rtScore > 0.85 ? 'bg-red-500' : rtScore > 0.6 ? 'bg-amber-500' : 'bg-emerald-500'
            )} style={{ width: `${rtScore * 100}%` }} />
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Wallet className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Weekly Premium</span>
          </div>
          {wLoading ? (
            <div className="skeleton h-8 w-20 rounded" />
          ) : (
            <p className="text-2xl font-bold text-primary">
              {formatINR(worker?.policy?.weekly_premium)}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground mt-1">
            SI: {formatINR(worker?.policy?.sum_insured)}
          </p>
        </div>
      </div>

      {/* Zone badge */}
      <div className={cn('flex items-center gap-3 rounded-xl border border-border bg-card p-4', riskBgColor(rtScore))}>
        <AlertTriangle className={cn('w-5 h-5', riskColor(rtScore))} />
        <div>
          <p className="text-sm font-medium">Zone: {zone || 'Scanning...'}</p>
          <p className="text-xs text-muted-foreground">S2 Level 13 cell active</p>
        </div>
      </div>

      {/* Recent claims */}
      <div>
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Clock className="w-4 h-4" /> Recent Claims
        </h2>
        {cLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <div key={i} className="skeleton h-16 w-full rounded-xl" />)}
          </div>
        ) : claims.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <Shield className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No claims yet</p>
            <p className="text-xs text-muted-foreground">Your coverage is active and monitoring</p>
          </div>
        ) : (
          <div className="space-y-2">
            {claims.slice(0, 5).map((claim: any) => (
              <div key={claim.claim_id} className="rounded-xl border border-border bg-card p-3 flex items-center justify-between">
                <div>
                  <p className="text-xs font-mono text-muted-foreground">{claim.claim_id}</p>
                  <p className="text-sm font-medium">{claim.payout_amount ? formatINR(claim.payout_amount) : 'Processing...'}</p>
                  <p className="text-[10px] text-muted-foreground" title={claim.created_at}>{relativeTime(claim.created_at)}</p>
                </div>
                <span className={cn('px-2.5 py-1 rounded-full text-[10px] font-semibold', stateBadgeColor(claim.state))}>
                  {claim.state}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
