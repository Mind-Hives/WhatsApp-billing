"use client";

import { useState, useTransition } from "react";

import { commitBatchAction } from "./actions";

export function CommitButton({ batchId }: { batchId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleCommit() {
    setError(null);
    startTransition(async () => {
      const result = await commitBatchAction(batchId);
      if (result.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-2">
      <button
        className="inline-flex items-center rounded-2xl border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:border-sky-400/60 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800/60 disabled:text-slate-500"
        disabled={isPending}
        onClick={handleCommit}
        type="button"
      >
        {isPending ? "Committing…" : "Commit valid rows"}
      </button>
      {error ? (
        <p className="max-w-xl text-sm leading-6 text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
