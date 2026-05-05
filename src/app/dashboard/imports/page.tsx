import { CommitButton } from "./commit-button";

import { createClient } from "@/utils/supabase/server";

type ImportBatch = {
  id: string;
  source: string;
  source_run_id: string | null;
  status: string;
  row_count: number;
  valid_row_count: number;
  invalid_row_count: number;
  created_at: string;
};

function truncate(value: string, length = 12) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusClassName(status: string) {
  if (status === "committed") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  }

  if (status === "staged") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  }

  return "border-slate-700 bg-slate-800/70 text-slate-300";
}

export default async function ImportsPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("import_batches")
    .select(
      "id, source, source_run_id, status, row_count, valid_row_count, invalid_row_count, created_at"
    )
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load import batches: ${error.message}`);
  }

  const batches = (data ?? []) as ImportBatch[];

  return (
    <section className="space-y-8">
      <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 shadow-xl shadow-slate-950/20">
        <span className="inline-flex rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-sm font-medium text-sky-200">
          Import management
        </span>
        <h2 className="mt-5 text-3xl font-semibold tracking-tight text-balance">
          Review staged imports and commit valid rows.
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300 sm:text-base">
          Staged batches remain isolated until an admin commits them. The commit
          action writes only valid rows into production tables and records the
          acting admin in audit logs.
        </p>
      </div>

      {batches.length === 0 ? (
        <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6">
          <h3 className="text-lg font-semibold text-slate-100">
            No staged imports yet
          </h3>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
            Import batches will appear here after the n8n ingestion flow stages
            rows for review. Once a batch is staged, admins can inspect its row
            counts and commit valid rows from this page.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {batches.map((batch) => (
            <article
              className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6"
              key={batch.id}
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-lg font-semibold text-slate-100">
                      {batch.source}
                    </h3>
                    <span
                      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] ${statusClassName(
                        batch.status
                      )}`}
                    >
                      {batch.status}
                    </span>
                  </div>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="text-slate-500">Batch ID</dt>
                      <dd className="mt-1 font-mono text-slate-200">
                        {truncate(batch.id)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Source run</dt>
                      <dd className="mt-1 font-mono text-slate-200">
                        {batch.source_run_id
                          ? truncate(batch.source_run_id)
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Created</dt>
                      <dd className="mt-1 text-slate-200">
                        {formatDate(batch.created_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Rows</dt>
                      <dd className="mt-1 text-slate-200">
                        {batch.row_count} total / {batch.valid_row_count} valid /{" "}
                        {batch.invalid_row_count} invalid
                      </dd>
                    </div>
                  </dl>
                </div>

                {batch.status === "staged" ? (
                  <CommitButton batchId={batch.id} />
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
