import { Outlet, Link, useLocation } from "react-router-dom";

const navItems = [
  { to: "/", label: "Permits" },
  { to: "/booking", label: "Booking" },
];

export default function Layout() {
  const location = useLocation();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-emerald-800 text-white shadow-lg">
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
                      ? "bg-emerald-700 text-white"
                      : "text-emerald-100 hover:bg-emerald-700/50"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-6xl mx-auto px-4 py-8 w-full">
        <Outlet />
      </main>
      <footer className="bg-stone-100 border-t border-stone-200 py-4 text-center text-sm text-stone-500">
        Backpack Bot &mdash; Data Source: Recreation.gov
      </footer>
    </div>
  );
}
