import { createClient } from "@/utils/supabase/server";

export async function requireAdminUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return { user: null, error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id, role, is_active")
    .eq("id", user.id)
    .maybeSingle<{ id: string; role: string; is_active: boolean }>();

  if (profileError || !profile || profile.role !== "admin" || !profile.is_active) {
    return { user: null, error: Response.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { user, error: null };
}
