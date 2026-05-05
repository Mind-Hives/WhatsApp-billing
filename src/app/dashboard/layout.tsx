import Link from "next/link";

const navigationItems = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/imports", label: "Imports" },
  { href: "/dashboard/companies", label: "Companies" },
  { href: "/dashboard/users", label: "Users" },
  { href: "/dashboard/numbers", label: "Numbers" },
  { href: "/dashboard/history", label: "History" },
  { href: "/dashboard/audit-logs", label: "Audit Logs" },
];

export default function DashboardLayout({
  children,
}: LayoutProps<"/dashboard">) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col lg:flex-row">
        <aside className="border-b border-slate-800 bg-slate-900/80 px-6 py-8 lg:min-h-screen lg:w-72 lg:border-b-0 lg:border-r">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-sky-200">
            Billing Admin
          </p>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-balance">
            Internal dashboard shell
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Empty structure for the first admin experience. Middleware and RLS
            enforce access while the remaining slices add real data surfaces.
          </p>
          <nav aria-label="Dashboard" className="mt-8">
            <ul className="space-y-2">
              {navigationItems.map((item) => (
                <li key={item.href}>
                  <Link
                    className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-sky-500/40 hover:text-sky-100"
                    href={item.href}
                  >
                    <span>{item.label}</span>
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-500">
                      Empty
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <div className="flex min-h-[50vh] flex-1 flex-col">
          <header className="border-b border-slate-800 px-6 py-5">
            <p className="text-sm text-slate-400">
              Authenticated routes live under
              <code className="ml-2 rounded bg-slate-900 px-2 py-1 font-mono text-slate-200">
                /dashboard
              </code>
            </p>
          </header>
          <main className="flex-1 px-6 py-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
