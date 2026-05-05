export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-24 text-slate-50">
      <div className="w-full max-w-3xl rounded-3xl border border-slate-800 bg-slate-900/80 p-10 shadow-2xl shadow-slate-950/40">
        <span className="inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-300">
          Scaffold ready
        </span>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Billing Admin scaffold
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-300">
          Next.js, Supabase, Vitest, and Playwright are wired together so the
          remaining slices can focus on auth, schema, and dashboard behavior.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
              App Router
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Source lives under <code className="font-mono">src/app</code>.
            </p>
          </section>
          <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
              Supabase
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Local project config is present under <code className="font-mono">supabase/</code>.
            </p>
          </section>
          <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
              Testing
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Vitest and Playwright both run against tracked local files.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
