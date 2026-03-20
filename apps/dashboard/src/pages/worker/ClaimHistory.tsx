import { useQuery } from '@tanstack/react-query';
import { claimsAPI } from '../../lib/api';
import { formatINR, relativeTime, absoluteTime, stateBadgeColor, cn } from '../../lib/utils';
import { FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

export default function ClaimHistory() {
  const { data, isLoading } = useQuery({
    queryKey: ['claims', 'GIG_0001'],
    queryFn: () => claimsAPI.getByWorker('GIG_0001').then((r) => r.data),
  });

  const claims = data?.claims || [];
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold flex items-center gap-2">
        <FileText className="w-5 h-5 text-primary" /> Claim History
      </h1>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="skeleton h-24 w-full rounded-xl" />)}
        </div>
      ) : claims.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <FileText className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No claims yet</p>
          <p className="text-xs text-muted-foreground mt-1">Claims are automatically initiated when disruptions are detected</p>
        </div>
      ) : (
        <div className="space-y-3">
          {claims.map((claim: any) => (
            <div key={claim.claim_id} className="rounded-xl border border-border bg-card overflow-hidden">
              <button
                onClick={() => setExpanded(expanded === claim.claim_id ? null : claim.claim_id)}
                className="w-full p-4 flex items-center justify-between text-left"
                aria-expanded={expanded === claim.claim_id}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground">{claim.claim_id}</span>
                    <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-semibold', stateBadgeColor(claim.state))}>
                      {claim.state}
                    </span>
                  </div>
                  <p className="text-sm font-bold mt-1">
                    {claim.payout_amount ? formatINR(claim.payout_amount) : 'Pending...'}
                  </p>
                  <p className="text-[10px] text-muted-foreground" title={absoluteTime(claim.created_at)}>
                    {relativeTime(claim.created_at)}
                  </p>
                </div>
                {expanded === claim.claim_id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>

              {expanded === claim.claim_id && (
                <div className="px-4 pb-4 border-t border-border pt-3 space-y-3 animate-slide-up">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-muted-foreground">Ward:</span> <span className="font-medium">{claim.ward_id}</span></div>
                    <div><span className="text-muted-foreground">Risk:</span> <span className="font-medium">{claim.risk_score?.toFixed(3)}</span></div>
                    <div><span className="text-muted-foreground">Fraud:</span> <span className="font-medium">{claim.fraud_verdict || 'Pending'}</span></div>
                    <div><span className="text-muted-foreground">Hours:</span> <span className="font-medium">{claim.hours_disrupted?.toFixed(1) || '—'}h</span></div>
                  </div>

                  {/* State transition timeline */}
                  {claim.transitions && claim.transitions.length > 0 && (
                    <div className="space-y-0">
                      <p className="text-[10px] font-semibold text-muted-foreground mb-2">State Transitions</p>
                      {claim.transitions.map((t: any, i: number) => (
                        <div key={i} className="flex items-start gap-2 relative">
                          <div className="flex flex-col items-center">
                            <div className="w-2 h-2 rounded-full bg-primary" />
                            {i < claim.transitions.length - 1 && <div className="w-px h-6 bg-border" />}
                          </div>
                          <div className="pb-2">
                            <p className="text-[10px] font-medium">{t.from} → {t.to}</p>
                            {t.reason && <p className="text-[9px] text-muted-foreground">{t.reason}</p>}
                            <p className="text-[9px] text-muted-foreground" title={absoluteTime(t.timestamp)}>{relativeTime(t.timestamp)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
