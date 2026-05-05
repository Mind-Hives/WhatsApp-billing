import { createClient } from "@supabase/supabase-js";

function getAdminConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !url.trim()) {
    throw new Error(
      "[imports] Admin client startup failed: NEXT_PUBLIC_SUPABASE_URL is missing."
    );
  }
  if (!anonKey || !anonKey.trim()) {
    throw new Error(
      "[imports] Admin client startup failed: NEXT_PUBLIC_SUPABASE_ANON_KEY is missing."
    );
  }
  if (!serviceRoleKey || !serviceRoleKey.trim()) {
    throw new Error(
      "[imports] Admin client startup failed: SUPABASE_SERVICE_ROLE_KEY is missing."
    );
  }

  return { url, serviceRoleKey };
}

// Returns a service-role Supabase client that bypasses RLS.
// Server-only — never import this in client components or expose it to the browser.
export function createAdminClient() {
  const { url, serviceRoleKey } = getAdminConfig();
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
