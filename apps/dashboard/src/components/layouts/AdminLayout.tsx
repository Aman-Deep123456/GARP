import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useUIStore } from '../../stores';
import { cn } from '../../lib/utils';
import {
  BarChart3, Map, Table2, TrendingUp, Zap,
  Users, Moon, Sun, Shield, ChevronLeft
} from 'lucide-react';

const adminNav = [
  { path: '/admin', icon: BarChart3, label: 'Loss Ratio', end: true },
  { path: '/admin/fraud', icon: Map, label: 'Fraud Map' },
  { path: '/admin/wards', icon: Table2, label: 'Ward Risk' },
  { path: '/admin/predictions', icon: TrendingUp, label: 'Predictions' },
  { path: '/admin/payouts', icon: Zap, label: 'Payouts' },
  { path: '/admin/workers', icon: Users, label: 'Workers' },
];

export default function AdminLayout() {
  const { darkMode, toggleDarkMode, sidebarOpen, toggleSidebar } = useUIStore();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar */}
      <aside className={cn(
        'fixed left-0 top-0 h-full border-r border-border glass-card z-40 transition-all duration-300',
        sidebarOpen ? 'w-56' : 'w-16'
      )}>
        <div className="flex items-center gap-3 px-4 h-14 border-b border-border">
          <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          {sidebarOpen && (
            <div>
              <h1 className="text-sm font-bold">GRAP Admin</h1>
              <p className="text-[10px] text-muted-foreground">Insurer Dashboard</p>
            </div>
          )}
        </div>

        <nav className="p-2 space-y-1" aria-label="Admin navigation">
          {adminNav.map(({ path, icon: Icon, label, end }) => (
            <NavLink
              key={path}
              to={path}
              end={end}
              className={({ isActive }) => cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
              aria-label={label}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {sidebarOpen && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="absolute bottom-4 left-0 right-0 px-2 space-y-1">
          <NavLink
            to="/"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            {sidebarOpen && <span>Worker View</span>}
          </NavLink>
          <button
            onClick={toggleDarkMode}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors w-full"
            aria-label="Toggle dark mode"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            {sidebarOpen && <span>{darkMode ? 'Light' : 'Dark'} Mode</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className={cn('flex-1 transition-all duration-300', sidebarOpen ? 'ml-56' : 'ml-16')}>
        <header className="sticky top-0 z-30 border-b border-border glass-card h-14 flex items-center px-6">
          <button onClick={toggleSidebar} className="p-2 rounded-lg hover:bg-muted transition-colors mr-4">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h2 className="text-sm font-semibold">{adminNav.find(n => n.path === location.pathname)?.label || 'Dashboard'}</h2>
        </header>

        <div className="p-6">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Outlet />
          </motion.div>
        </div>
      </main>
    </div>
  );
}
