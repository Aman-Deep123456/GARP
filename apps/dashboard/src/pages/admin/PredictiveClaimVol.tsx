import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LineChart, Line } from 'recharts';
import { TrendingUp } from 'lucide-react';

const volumeData = Array.from({ length: 14 }, (_, i) => ({
  day: `Day ${i + 1}`,
  actual: Math.floor(5 + Math.random() * 15),
  predicted: Math.floor(8 + Math.random() * 10),
}));

const weeklyForecast = Array.from({ length: 8 }, (_, i) => ({
  week: `W${i + 1}`,
  volume: Math.floor(30 + Math.random() * 40),
  lower: Math.floor(20 + Math.random() * 20),
  upper: Math.floor(50 + Math.random() * 30),
}));

export default function PredictiveClaimVol() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold flex items-center gap-2">
        <TrendingUp className="w-5 h-5" /> Predictive Claim Volume
      </h1>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          <p className="text-[10px] text-muted-foreground">Today Predicted</p>
          <p className="text-3xl font-bold text-primary mt-1">12</p>
          <p className="text-xs text-muted-foreground">claims</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          <p className="text-[10px] text-muted-foreground">This Week</p>
          <p className="text-3xl font-bold mt-1">47</p>
          <p className="text-xs text-muted-foreground">claims</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          <p className="text-[10px] text-muted-foreground">Model R²</p>
          <p className="text-3xl font-bold text-emerald-400 mt-1">0.84</p>
          <p className="text-xs text-muted-foreground">accuracy</p>
        </div>
      </div>

      {/* Actual vs Predicted */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm font-semibold mb-4">Actual vs Predicted (14 Days)</p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={volumeData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(215, 27.9%, 16.9%)" />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" />
              <Tooltip contentStyle={{ background: 'hsl(224, 71.4%, 6%)', border: '1px solid hsl(215, 27.9%, 16.9%)', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="actual" fill="#10b981" radius={[4, 4, 0, 0]} name="Actual" />
              <Bar dataKey="predicted" fill="#6366f1" radius={[4, 4, 0, 0]} opacity={0.5} name="Predicted" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 8-week forecast */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm font-semibold mb-4">8-Week Forecast (with confidence interval)</p>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={weeklyForecast}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(215, 27.9%, 16.9%)" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" />
              <Tooltip contentStyle={{ background: 'hsl(224, 71.4%, 6%)', border: '1px solid hsl(215, 27.9%, 16.9%)', borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="volume" stroke="#10b981" strokeWidth={2} name="Forecast" />
              <Line type="monotone" dataKey="upper" stroke="#10b981" strokeWidth={1} strokeDasharray="4 4" opacity={0.3} name="Upper CI" />
              <Line type="monotone" dataKey="lower" stroke="#10b981" strokeWidth={1} strokeDasharray="4 4" opacity={0.3} name="Lower CI" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
