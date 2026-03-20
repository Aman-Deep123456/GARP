import { Map, AlertTriangle } from 'lucide-react';

const fraudData = [
  { ward: 'MUM_KURLA_W12', name: 'Kurla West', fraud_count: 12, avg_score: 0.68, lat: 19.0726, lon: 72.8793 },
  { ward: 'MUM_ANDHERI_W58', name: 'Andheri West', fraud_count: 5, avg_score: 0.45, lat: 19.1197, lon: 72.8464 },
  { ward: 'MUM_BANDRA_W43', name: 'Bandra West', fraud_count: 3, avg_score: 0.32, lat: 19.0544, lon: 72.8402 },
  { ward: 'MUM_DADAR_W25', name: 'Dadar', fraud_count: 8, avg_score: 0.55, lat: 19.0178, lon: 72.8478 },
  { ward: 'MUM_POWAI_W91', name: 'Powai', fraud_count: 2, avg_score: 0.28, lat: 19.1176, lon: 72.9061 },
];

export default function FraudHeatmap() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold flex items-center gap-2">
        <Map className="w-5 h-5" /> Fraud Heatmap
      </h1>

      {/* Map placeholder — in production would use Leaflet with S2 zone overlays */}
      <div className="rounded-xl border border-border bg-card p-1 overflow-hidden">
        <div className="h-80 bg-gradient-to-br from-slate-800 to-slate-900 rounded-lg flex items-center justify-center relative">
          <div className="text-center">
            <Map className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Mumbai Ward Map</p>
            <p className="text-xs text-muted-foreground">S2 Level 13 zone overlays</p>
          </div>
          {/* Ward indicators */}
          {fraudData.map((w) => {
            const x = ((w.lon - 72.83) / 0.1) * 100;
            const y = 100 - ((w.lat - 19.01) / 0.12) * 100;
            return (
              <div
                key={w.ward}
                className="absolute"
                style={{ left: `${Math.max(10, Math.min(90, x))}%`, top: `${Math.max(10, Math.min(90, y))}%` }}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[9px] font-bold animate-pulse ${
                  w.avg_score > 0.6 ? 'bg-red-500/40 text-red-300' :
                  w.avg_score > 0.4 ? 'bg-amber-500/40 text-amber-300' :
                  'bg-emerald-500/40 text-emerald-300'
                }`}>
                  {w.fraud_count}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Fraud table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground">Ward</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground">Fraud Flags</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground">Avg Score</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground">Risk</th>
            </tr>
          </thead>
          <tbody>
            {fraudData.map((w) => (
              <tr key={w.ward} className="border-b border-border hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3">
                  <p className="text-sm font-medium">{w.name}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">{w.ward}</p>
                </td>
                <td className="px-4 py-3 text-sm font-bold">{w.fraud_count}</td>
                <td className="px-4 py-3 text-sm font-mono">{w.avg_score.toFixed(2)}</td>
                <td className="px-4 py-3">
                  <div className="h-2 w-16 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${w.avg_score > 0.6 ? 'bg-red-500' : w.avg_score > 0.4 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${w.avg_score * 100}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Fraud layers breakdown */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'GNSS Spoofing', weight: '30%', detections: 8 },
          { label: 'Kinematic FFT', weight: '35%', detections: 5 },
          { label: 'Network Verify', weight: '20%', detections: 3 },
          { label: 'Play Integrity', weight: '15%', detections: 1 },
        ].map((l) => (
          <div key={l.label} className="rounded-xl border border-border bg-card p-4">
            <p className="text-[10px] text-muted-foreground">{l.label}</p>
            <p className="text-lg font-bold mt-1">{l.detections}</p>
            <p className="text-[10px] text-muted-foreground">Weight: λ={l.weight}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
