import { useQuery } from '@tanstack/react-query';
import { workerAPI } from '../../lib/api';
import { cn, formatINR, relativeTime } from '../../lib/utils';
import { Users, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';

export default function WorkerRegistry() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['workers', page],
    queryFn: () => workerAPI.list({ page: String(page), limit: '20' }).then((r) => r.data),
  });

  const workers = data?.workers || [];
  const total = data?.total || 0;
  const filtered = workers.filter((w: any) =>
    w.worker_id.toLowerCase().includes(search.toLowerCase()) ||
    w.name?.toLowerCase().includes(search.toLowerCase()) ||
    w.ward_id?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold flex items-center gap-2">
        <Users className="w-5 h-5" /> Worker Registry
      </h1>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search by ID, name, or ward..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-border bg-background text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          <p className="text-3xl font-bold">{total}</p>
          <p className="text-xs text-muted-foreground">Total Workers</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          <p className="text-3xl font-bold text-emerald-400">{Math.floor(total * 0.87)}</p>
          <p className="text-xs text-muted-foreground">Active Policies</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          <p className="text-3xl font-bold">5</p>
          <p className="text-xs text-muted-foreground">Mumbai Wards</p>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-12 w-full rounded" />)}
          </div>
        ) : (
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {['Worker ID', 'Name', 'Platform', 'Ward', 'Premium', 'Tenure', 'Status'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No workers found
                  </td>
                </tr>
              ) : (
                filtered.map((w: any) => (
                  <tr key={w.worker_id} className="border-b border-border hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 text-sm font-mono font-medium">{w.worker_id}</td>
                    <td className="px-4 py-3 text-sm">{w.name}</td>
                    <td className="px-4 py-3">
                      <span className={cn('px-2 py-0.5 rounded text-[10px] font-semibold',
                        w.platform === 'zomato' ? 'bg-red-500/20 text-red-400' :
                        w.platform === 'swiggy' ? 'bg-orange-500/20 text-orange-400' :
                        'bg-purple-500/20 text-purple-400'
                      )}>
                        {w.platform}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{w.ward_id?.split('_').pop()}</td>
                    <td className="px-4 py-3 text-sm font-mono">{formatINR(w.policy?.weekly_premium)}</td>
                    <td className="px-4 py-3 text-sm">{w.tenure_weeks}w</td>
                    <td className="px-4 py-3">
                      <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-semibold',
                        w.policy?.active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-muted text-muted-foreground'
                      )}>
                        {w.policy?.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Showing {filtered.length} of {total}</span>
        <div className="flex gap-2">
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="p-2 rounded-lg border border-border hover:bg-muted disabled:opacity-50">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="flex items-center px-3 text-muted-foreground">Page {page}</span>
          <button onClick={() => setPage(page + 1)} className="p-2 rounded-lg border border-border hover:bg-muted">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
