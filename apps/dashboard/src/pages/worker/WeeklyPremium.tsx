import { useQuery } from '@tanstack/react-query';
import { workerAPI } from '../../lib/api';
import { formatINR } from '../../lib/utils';
import { Wallet, TrendingDown, Calendar, Info } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const premiumHistory = Array.from({ length: 12 }, (_, i) => ({
  week: `W${i + 1}`,
  premium: 20 + Math.random() * 35,
  wardAvg: 25 + Math.random() * 20,
}));

export default function WeeklyPremium() {
  const { data: policy, isLoading } = useQuery({
    queryKey: ['policy', 'GIG_0001'],
    queryFn: () => workerAPI.getPolicy('GIG_0001').then((r) => r.data),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold flex items-center gap-2">
        <Wallet className="w-5 h-5 text-primary" /> Weekly Premium
      </h1>

      {/* Current premium */}
      <div className="rounded-2xl bg-gradient-to-br from-violet-600/20 to-indigo-600/20 border border-violet-500/30 p-5">
        <p className="text-[10px] uppercase text-muted-foreground">This Week's Premium</p>
        {isLoading ? (
          <div className="skeleton h-10 w-32 rounded mt-2" />
        ) : (
          <p className="text-4xl font-bold text-foreground mt-1">{formatINR(policy?.weekly_premium)}</p>
        )}
        <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><TrendingDown className="w-3 h-3 text-emerald-400" /> 12% less than last week</span>
          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> Updated Mon 02:00 IST</span>
        </div>
      </div>

      {/* Premium range info */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Info className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-medium">Dynamic Pricing</span>
        </div>
        <div className="flex justify-between items-center">
          <div className="text-center">
            <p className="text-lg font-bold text-emerald-400">{formatINR(12)}</p>
            <p className="text-[10px] text-muted-foreground">Min / week</p>
          </div>
          <div className="flex-1 mx-4 h-2 rounded-full bg-gradient-to-r from-emerald-500 via-amber-500 to-red-500 relative">
            <div className="absolute -top-1 w-4 h-4 rounded-full bg-white border-2 border-primary shadow-lg"
              style={{ left: `${((policy?.weekly_premium || 28) - 12) / 43 * 100}%`, transform: 'translateX(-50%)' }} />
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-red-400">{formatINR(55)}</p>
            <p className="text-[10px] text-muted-foreground">Max / week</p>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mt-3 text-center">
          Tweedie GLM with 11 predictors · Bühlmann credibility adjusted
        </p>
      </div>

      {/* Premium trend chart */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs font-medium mb-3">12-Week Premium Trend</p>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={premiumHistory}>
              <defs>
                <linearGradient id="premGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(151, 65%, 42%)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(151, 65%, 42%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="week" tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 27.9%, 16.9%)" />
              <Tooltip contentStyle={{ background: 'hsl(224, 71.4%, 6%)', border: '1px solid hsl(215, 27.9%, 16.9%)', borderRadius: 8, fontSize: 12 }} />
              <Area type="monotone" dataKey="premium" stroke="hsl(151, 65%, 42%)" fill="url(#premGrad)" strokeWidth={2} name="Your Premium" />
              <Area type="monotone" dataKey="wardAvg" stroke="hsl(215, 20.2%, 65.1%)" fill="none" strokeWidth={1} strokeDasharray="4 4" name="Ward Average" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Coverage details */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs font-medium mb-3">Coverage Details</p>
        <div className="space-y-2.5">
          {[
            ['Sum Insured', formatINR(policy?.sum_insured || 2500) + '/week'],
            ['Daily Rate', formatINR((policy?.sum_insured || 2500) / 7)],
            ['DST Fallback', '8.2 hours (P90)'],
            ['Hourly Rate', formatINR((policy?.sum_insured || 2500) / 7 / 8.2)],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-medium">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
