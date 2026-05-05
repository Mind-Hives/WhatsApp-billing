const entityCards = [
  {
    title: "Companies",
    description: "Company records and account ownership will appear here.",
  },
  {
    title: "Users",
    description: "Admin and tenant user access management will appear here.",
  },
  {
    title: "Numbers",
    description: "Assigned billing numbers and status workflows will appear here.",
  },
  {
    title: "History",
    description: "Timeline and change history surfaces will appear here.",
  },
  {
    title: "Audit Logs",
    description: "Compliance-oriented activity trails will appear here.",
  },
];

export default function DashboardPage() {
  return (
    <section className="space-y-8">
      <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 shadow-xl shadow-slate-950/20">
        <span className="inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-300">
          Protected route
        </span>
        <h2 className="mt-5 text-3xl font-semibold tracking-tight text-balance">
          Dashboard structure is ready for data wiring.
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300 sm:text-base">
          This first slice intentionally renders an empty shell so admins can
          verify authentication, protected navigation, and route boundaries
          before the remaining entity pages are built.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {entityCards.map((card) => (
          <article
            key={card.title}
            className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6"
          >
            <h3 className="text-lg font-semibold text-slate-100">
              {card.title}
            </h3>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              {card.description}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
