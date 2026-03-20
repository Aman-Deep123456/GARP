import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTelemetryStore, useUIStore } from '../../stores';
import { cn, riskColor, riskBgColor } from '../../lib/utils';
import {
  Home, Radio, UserPlus, Shield, Wallet, FileText,
  AlertTriangle, Settings, Moon, Sun, LayoutDashboard
} from 'lucide-react';

const navItems = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/simulator', icon: Radio, label: 'Simulator' },
  { path: '/onboarding', icon: UserPlus, label: 'Onboard' },
  { path: '/coverage', icon: Shield, label: 'Coverage' },
  { path: '/premium', icon: Wallet, label: 'Premium' },
  { path: '/claims', icon: FileText, label: 'Claims' },
  { path: '/alerts', icon: AlertTriangle, label: 'Alerts' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

export default function WorkerLayout() {
  const rtScore = useTelemetryStore((s) => s.rtScore);
  const zone = useTelemetryStore((s) => s.zone);
  const { darkMode, toggleDarkMode } = useUIStore();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar with Rt indicator */}
      <header className="sticky top-0 z-50 border-b border-border glass-card">
        <div className="flex items-center justify-between px-4 h-14">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-foreground">GRAP</h1>
              <p className="text-[10px] text-muted-foreground">Insurance Shield</p>
            </div>
          </div>

          {/* Live Rt badge */}
          <div className={cn('flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono font-semibold', riskBgColor(rtScore))}>
            <span className={cn('w-2 h-2 rounded-full animate-pulse', rtScore > 0.85 ? 'bg-red-500' : rtScore > 0.6 ? 'bg-amber-500' : 'bg-emerald-500')} />
            <span className={riskColor(rtScore)}>Rt {rtScore.toFixed(2)}</span>
            {zone && <span className="text-muted-foreground">| {zone.split('_').pop()}</span>}
          </div>

          <div className="flex items-center gap-2">
            <button onClick={toggleDarkMode} className="p-2 rounded-lg hover:bg-muted transition-colors" aria-label="Toggle dark mode">
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <NavLink to="/admin" className="p-2 rounded-lg hover:bg-muted transition-colors" aria-label="Admin dashboard">
              <LayoutDashboard className="w-4 h-4" />
            </NavLink>
          </div>
        </div>

        {/* Risk bar */}
        <div className="h-1 bg-muted">
          <div className={cn('h-full risk-gauge-fill transition-all',
            rtScore > 0.85 ? 'bg-red-500' : rtScore > 0.6 ? 'bg-amber-500' : rtScore > 0.3 ? 'bg-yellow-500' : 'bg-emerald-500'
          )} style={{ width: `${rtScore * 100}%` }} />
        </div>
      </header>

      {/* Content */}
      <main className="pb-20 px-4 pt-4 max-w-lg mx-auto">
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          <Outlet />
        </motion.div>
      </main>

      {/* Bottom navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border glass-card" aria-label="Worker navigation">
        <div className="flex justify-around items-center h-16 max-w-lg mx-auto">
          {navItems.slice(0, 5).map(({ path, icon: Icon, label }) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) => cn(
                'flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
              aria-label={label}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
