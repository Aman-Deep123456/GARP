import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatINR } from '../../lib/utils';
import { TrendingUp, TrendingDown, DollarSign, Shield } from 'lucide-react';

const lossData = Array.from({ length: 24 }, (_, i) => ({
  week: `W${i + 1}`,
  premiums: 8000 + Math.random() * 5000,
  claims: 3000 + Math.random() * 6000,
  ratio: 0.35 + Math.random() * 0.4,
}));

const stats = [
  { label: 'Total Premiums', value: '₹4,23,500', change: '+8.2%', up: true, icon: DollarSign },
  { label: 'Total Claims Paid', value: '₹1,87,320', change: '+12.1%', up: true, icon: Shield },
  { label: 'Loss Ratio', value: '44.2%', change: '-3.1%', up: false, icon: TrendingDown },
  { label: 'Active Policies', value: '487', change: '+2', up: true, icon: TrendingUp },
];

export default function LossRatioMonitor() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Loss Ratio Monitor</h1>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <s.icon className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </div>
            <p className="text-2xl font-bold">{s.value}</p>
            <span className={`text-xs font-medium ${s.up ? 'text-emerald-400' : 'text-red-400'}`}>{s.change}</span>
          </div>
        ))}
      </div>

      {/* Premium vs Claims chart */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm font-semibold mb-4">Premiums vs Claims (24 Weeks)</p>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={lossData}>
              <defs>
                <linearGradient id="premG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="claimG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(215, 27.9%, 16.9%)" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" tickFormatter={(v) => `₹${(v/1000).toFixed(0)}k`} />
              <Tooltip contentStyle={{ background: 'hsl(224, 71.4%, 6%)', border: '1px solid hsl(215, 27.9%, 16.9%)', borderRadius: 8, fontSize: 12 }} formatter={(v: number) => formatINR(v)} />
              <Area type="monotone" dataKey="premiums" stroke="#10b981" fill="url(#premG)" strokeWidth={2} name="Premiums" />
              <Area type="monotone" dataKey="claims" stroke="#ef4444" fill="url(#claimG)" strokeWidth={2} name="Claims Paid" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Loss ratio trend */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm font-semibold mb-4">Loss Ratio Trend</p>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={lossData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(215, 27.9%, 16.9%)" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} />
              <Tooltip contentStyle={{ background: 'hsl(224, 71.4%, 6%)', border: '1px solid hsl(215, 27.9%, 16.9%)', borderRadius: 8, fontSize: 12 }} formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
              <Area type="monotone" dataKey="ratio" stroke="#f59e0b" fill="none" strokeWidth={2} name="Loss Ratio" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
