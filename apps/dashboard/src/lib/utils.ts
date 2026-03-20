import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow, format } from 'date-fns';

/** Merge Tailwind classes with clsx */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format monetary values as ₹XX,XXX.XX */
export function formatINR(amount: number | undefined | null): string {
  if (amount == null) return '₹0.00';
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Relative timestamp (e.g. "2 min ago") */
export function relativeTime(date: string | Date): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

/** Absolute timestamp for hover tooltip */
export function absoluteTime(date: string | Date): string {
  return format(new Date(date), 'dd MMM yyyy HH:mm:ss');
}

/** Get risk level color based on score */
export function riskColor(score: number): string {
  if (score >= 0.85) return 'text-red-500';
  if (score >= 0.6) return 'text-amber-500';
  if (score >= 0.3) return 'text-yellow-500';
  return 'text-emerald-500';
}

/** Get risk level background */
export function riskBgColor(score: number): string {
  if (score >= 0.85) return 'bg-red-500/20';
  if (score >= 0.6) return 'bg-amber-500/20';
  if (score >= 0.3) return 'bg-yellow-500/20';
  return 'bg-emerald-500/20';
}

/** Get state badge color for DFA states */
export function stateBadgeColor(state: string): string {
  const colors: Record<string, string> = {
    ACTIVE: 'bg-emerald-500/20 text-emerald-400',
    INITIATED: 'bg-blue-500/20 text-blue-400',
    VALIDATING: 'bg-purple-500/20 text-purple-400',
    READY_PAY: 'bg-cyan-500/20 text-cyan-400',
    PROCESSING: 'bg-amber-500/20 text-amber-400',
    RETRY: 'bg-orange-500/20 text-orange-400',
    SETTLED: 'bg-emerald-500/20 text-emerald-400',
    REJECTED: 'bg-red-500/20 text-red-400',
    FAILED: 'bg-red-700/20 text-red-500',
  };
  return colors[state] || 'bg-muted text-muted-foreground';
}
