"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

const GENERIC_LOGIN_ERROR =
  "We couldn’t sign you in. Check your credentials and try again.";
const FALLBACK_REDIRECT = "/dashboard";

function getRedirectTarget(redirectedFrom: string | undefined) {
  if (!redirectedFrom || !redirectedFrom.startsWith("/dashboard")) {
    return FALLBACK_REDIRECT;
  }

  return redirectedFrom;
}

type LoginFormProps = {
  redirectedFrom?: string;
};

export function LoginForm({ redirectedFrom }: LoginFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        console.error("[auth] Login failed.", {
          email,
          code: error.code,
          message: error.message,
          name: error.name,
          status: error.status,
        });
        setErrorMessage(GENERIC_LOGIN_ERROR);
        return;
      }

      const redirectTarget = getRedirectTarget(redirectedFrom);
      console.info(`[auth] Login succeeded; redirecting to ${redirectTarget}.`);
      router.replace(redirectTarget);
      router.refresh();
    } catch (error) {
      console.error("[auth] Login request failed unexpectedly.", error);
      setErrorMessage(GENERIC_LOGIN_ERROR);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-24 text-slate-50">
      <div className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl shadow-slate-950/40">
        <span className="inline-flex rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-sm font-medium text-sky-200">
          Admin access
        </span>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">
          Sign in to Billing Admin
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Use your Supabase email and password to access the internal billing
          console.
        </p>
        {redirectedFrom ? (
          <p className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            Please sign in to continue to
            <span className="ml-1 font-mono text-amber-50">
              {redirectedFrom}
            </span>
            .
          </p>
        ) : null}
        <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
          <div>
            <label
              className="mb-2 block text-sm font-medium text-slate-200"
              htmlFor="email"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-50 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20"
              placeholder="admin@example.com"
            />
          </div>
          <div>
            <label
              className="mb-2 block text-sm font-medium text-slate-200"
              htmlFor="password"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-50 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20"
              placeholder="••••••••"
            />
          </div>
          {errorMessage ? (
            <p
              aria-live="polite"
              className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
            >
              {errorMessage}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex w-full items-center justify-center rounded-2xl bg-sky-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
          >
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="mt-6 text-sm text-slate-400">
          Need a different route? Return to the{" "}
          <Link className="text-sky-300 hover:text-sky-200" href="/">
            project home page
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
