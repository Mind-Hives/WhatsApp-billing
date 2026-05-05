"use server";

import { revalidatePath } from "next/cache";

import { commitBatch } from "@/features/imports/commit-batch";
import { createClient } from "@/utils/supabase/server";

export async function commitBatchAction(
  batchId: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Unauthorized" };
  }

  try {
    await commitBatch({ batchId, actorUserId: user.id });
    revalidatePath("/dashboard/imports");
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Commit failed" };
  }
}
