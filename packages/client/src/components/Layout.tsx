import { Outlet, Link, useLocation } from "react-router-dom";

const navItems = [
  { to: "/", label: "Sniper" },
];

export default function Layout() {
  const location = useLocation();

  return (
    <div className="min-h-screen flex flex-col bg-stone-900">
      <header className="bg-stone-800 border-b border-stone-700 text-white shadow-lg">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 hover:opacity-90 transition">
            <span className="text-2xl font-bold tracking-tight">Backpack Bot</span>
          </Link>
          <nav className="flex gap-1">
            {navItems.map((item) => {
              const isActive =
                item.to === "/"
                  ? location.pathname === "/"
                  : location.pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                    isActive
                      ? "bg-emerald-600 text-white"
                      : "text-stone-300 hover:bg-stone-700 hover:text-white"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-6xl mx-auto px-4 py-8 w-full text-stone-200">
        <Outlet />
      </main>
      <footer className="bg-stone-800 border-t border-stone-700 py-4 text-center text-sm text-stone-400">
        Backpack Bot &mdash; Data Source: Recreation.gov
      </footer>
    </div>
  );
}
