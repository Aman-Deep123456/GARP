import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatINR } from '../../lib/utils';
import { Zap, Clock, CheckCircle, XCircle } from 'lucide-react';

const payoutData = Array.from({ length: 14 }, (_, i) => ({
  day: `Day ${i + 1}`,
  amount: 5000 + Math.random() * 15000,
  count: Math.floor(3 + Math.random() * 10),
  avg_time: 10 + Math.random() * 50,
}));

export default function PayoutVelocity() {
  const totalPaid = payoutData.reduce((s, d) => s + d.amount, 0);
  const avgTime = payoutData.reduce((s, d) => s + d.avg_time, 0) / payoutData.length;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold flex items-center gap-2">
        <Zap className="w-5 h-5" /> Payout Velocity
      </h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Paid (14d)', value: formatINR(totalPaid), icon: CheckCircle, color: 'text-emerald-400' },
          { label: 'Avg Settlement', value: `${avgTime.toFixed(0)} min`, icon: Clock, color: 'text-amber-400' },
          { label: 'Success Rate', value: '94.2%', icon: CheckCircle, color: 'text-emerald-400' },
          { label: 'Failed Payouts', value: '3', icon: XCircle, color: 'text-red-400' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <s.icon className={`w-4 h-4 ${s.color}`} />
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </div>
            <p className="text-xl font-bold">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm font-semibold mb-4">Daily Payout Volume (14 Days)</p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={payoutData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(215, 27.9%, 16.9%)" />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" tickFormatter={(v) => `₹${(v/1000).toFixed(0)}k`} />
              <Tooltip contentStyle={{ background: 'hsl(224, 71.4%, 6%)', border: '1px solid hsl(215, 27.9%, 16.9%)', borderRadius: 8, fontSize: 12 }} formatter={(v: number) => formatINR(v)} />
              <Bar dataKey="amount" fill="#10b981" radius={[4, 4, 0, 0]} name="Payout Amount" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
