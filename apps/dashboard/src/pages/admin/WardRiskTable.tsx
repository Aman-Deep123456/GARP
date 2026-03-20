import { Table2 } from 'lucide-react';
import { cn } from '../../lib/utils';

const wardData = [
  { id: 'MUM_KURLA_W12', name: 'Kurla West', workers: 112, rain: 0.92, aqi: 0.25, flood: 0.0, rt_avg: 0.71, active_claims: 8, premium_avg: 38.5 },
  { id: 'MUM_ANDHERI_W58', name: 'Andheri West', workers: 98, rain: 0.45, aqi: 0.35, flood: 0.0, rt_avg: 0.42, active_claims: 3, premium_avg: 28.2 },
  { id: 'MUM_BANDRA_W43', name: 'Bandra West', workers: 105, rain: 0.30, aqi: 0.20, flood: 0.0, rt_avg: 0.28, active_claims: 1, premium_avg: 22.1 },
  { id: 'MUM_DADAR_W25', name: 'Dadar', workers: 95, rain: 0.55, aqi: 0.40, flood: 0.0, rt_avg: 0.52, active_claims: 5, premium_avg: 31.8 },
  { id: 'MUM_POWAI_W91', name: 'Powai', workers: 90, rain: 0.20, aqi: 0.15, flood: 0.0, rt_avg: 0.18, active_claims: 0, premium_avg: 18.5 },
];

function riskBadge(val: number) {
  if (val >= 0.7) return 'bg-red-500/20 text-red-400';
  if (val >= 0.4) return 'bg-amber-500/20 text-amber-400';
  return 'bg-emerald-500/20 text-emerald-400';
}

export default function WardRiskTable() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold flex items-center gap-2">
        <Table2 className="w-5 h-5" /> Ward Risk Table
      </h1>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {['Ward', 'Workers', 'Rain', 'AQI', 'Flood', 'Avg Rt', 'Claims', 'Avg Premium'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {wardData.map((w) => (
              <tr key={w.id} className="border-b border-border hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3">
                  <p className="text-sm font-medium">{w.name}</p>
                  <p className="text-[10px] font-mono text-muted-foreground">{w.id}</p>
                </td>
                <td className="px-4 py-3 text-sm font-bold">{w.workers}</td>
                <td className="px-4 py-3">
                  <span className={cn('px-2 py-0.5 rounded text-xs font-mono', riskBadge(w.rain))}>{w.rain.toFixed(2)}</span>
                </td>
                <td className="px-4 py-3">
                  <span className={cn('px-2 py-0.5 rounded text-xs font-mono', riskBadge(w.aqi))}>{w.aqi.toFixed(2)}</span>
                </td>
                <td className="px-4 py-3">
                  <span className={cn('px-2 py-0.5 rounded text-xs font-mono', riskBadge(w.flood))}>{w.flood.toFixed(1)}</span>
                </td>
                <td className="px-4 py-3">
                  <span className={cn('px-2 py-0.5 rounded text-xs font-mono font-bold', riskBadge(w.rt_avg))}>{w.rt_avg.toFixed(2)}</span>
                </td>
                <td className="px-4 py-3 text-sm font-bold">{w.active_claims}</td>
                <td className="px-4 py-3 text-sm font-mono">₹{w.premium_avg.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-500/20" /> Safe (&lt;0.4)</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-500/20" /> Warning (0.4-0.7)</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-500/20" /> Critical (&gt;0.7)</span>
      </div>
    </div>
  );
}
