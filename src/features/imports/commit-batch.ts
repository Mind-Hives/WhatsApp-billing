import { createAdminClient } from "@/utils/supabase/admin";

export interface CommitBatchInput {
  batchId: string;
  actorUserId: string;
}

export interface CommitBatchResult {
  committed: number;
  skipped: number;
}

// Escape PostgreSQL ILIKE special chars so the pattern is treated as a literal.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export async function commitBatch(
  input: CommitBatchInput
): Promise<CommitBatchResult> {
  const { batchId, actorUserId } = input;
  const supabase = createAdminClient();

  // 1. Already-committed guard
  const { data: batchRow, error: batchLookupError } = await supabase
    .from("import_batches")
    .select("status")
    .eq("id", batchId)
    .maybeSingle();

  if (batchLookupError) {
    console.error(
      `[imports] batch lookup failed batch_id=${batchId}: ${batchLookupError.message}`
    );
    throw batchLookupError;
  }

  if (batchRow?.status === "committed") {
    console.log(`[imports] batch already committed batch_id=${batchId}`);
    return { committed: 0, skipped: 0 };
  }

  // 2. Fetch valid items
  const { data: items, error: itemsError } = await supabase
    .from("import_items")
    .select("*")
    .eq("batch_id", batchId)
    .eq("status", "valid");

  if (itemsError) {
    console.error(
      `[imports] items lookup failed batch_id=${batchId}: ${itemsError.message}`
    );
    throw itemsError;
  }

  const validItems = items ?? [];
  let committed = 0;
  let skipped = 0;

  // 3. Per-item production writes
  for (const item of validItems) {
    // a. Company SELECT-then-INSERT
    // companies_name_unique_idx is on lower(name); upsert on 'name' won't hit it.
    // Use ilike with escaped pattern for case-insensitive exact match.
    const { data: existingCompany, error: companySelectError } = await supabase
      .from("companies")
      .select("id")
      .ilike("name", escapeLike(item.company_name ?? ""))
      .maybeSingle();

    if (companySelectError) {
      console.error(
        `[imports] company select failed batch_id=${batchId} company=${item.company_name}: ${companySelectError.message}`
      );
      throw companySelectError;
    }

    let companyId: string;

    if (existingCompany) {
      console.log(
        `[imports] company exists batch_id=${batchId} company_id=${existingCompany.id}`
      );
      companyId = existingCompany.id;
    } else {
      const insertPayload: { name: string; billing_email?: string } = {
        name: item.company_name,
      };
      if (item.user_email) {
        insertPayload.billing_email = item.user_email;
      }

      const { data: newCompany, error: companyInsertError } = await supabase
        .from("companies")
        .insert(insertPayload)
        .select("id")
        .single();

      if (companyInsertError || !newCompany) {
        console.error(
          `[imports] company insert failed batch_id=${batchId} company=${item.company_name}: ${companyInsertError?.message ?? "no data"}`
        );
        throw companyInsertError ?? new Error("[imports] company insert returned no data");
      }

      console.log(
        `[imports] company inserted batch_id=${batchId} company_id=${newCompany.id}`
      );
      companyId = newCompany.id;
    }

    // b. Number upsert — numbers_phone_number_unique_idx is a plain unique index.
    // numbers table has no company_id column; association is via assignment_history.
    const { data: numberRow, error: numberUpsertError } = await supabase
      .from("numbers")
      .upsert(
        {
          phone_number: item.phone_number,
          twilio_status: "unknown",
          assignment_status: "unassigned",
          billing_status: "inactive",
        },
        { onConflict: "phone_number" }
      )
      .select("id")
      .single();

    if (numberUpsertError || !numberRow) {
      console.error(
        `[imports] number upsert failed batch_id=${batchId} phone=${item.phone_number}: ${numberUpsertError?.message ?? "no data"}`
      );
      throw numberUpsertError ?? new Error("[imports] number upsert returned no data");
    }

    const numberId = numberRow.id;

    // c. Assignment history open-guard
    // assignment_history_open_number_unique_idx is PARTIAL on (number_id) WHERE assigned_to IS NULL.
    const { data: openAssignment, error: assignmentSelectError } = await supabase
      .from("assignment_history")
      .select("id")
      .eq("number_id", numberId)
      .is("assigned_to", null)
      .maybeSingle();

    if (assignmentSelectError) {
      console.error(
        `[imports] assignment select failed batch_id=${batchId} number_id=${numberId}: ${assignmentSelectError.message}`
      );
      throw assignmentSelectError;
    }

    if (openAssignment) {
      console.log(
        `[imports] open assignment exists number_id=${numberId} batch_id=${batchId}`
      );
      skipped++;
    } else {
      const { error: assignmentInsertError } = await supabase
        .from("assignment_history")
        .insert({
          number_id: numberId,
          company_id: companyId,
          assigned_from: new Date().toISOString(),
        });

      if (assignmentInsertError) {
        console.error(
          `[imports] assignment insert failed batch_id=${batchId} number_id=${numberId}: ${assignmentInsertError.message}`
        );
        throw assignmentInsertError;
      }

      committed++;
    }
  }

  // 4. Bulk-update items to 'committed'
  const { error: itemsUpdateError } = await supabase
    .from("import_items")
    .update({ status: "committed" })
    .eq("batch_id", batchId)
    .eq("status", "valid");

  if (itemsUpdateError) {
    console.error(
      `[imports] items update failed batch_id=${batchId}: ${itemsUpdateError.message}`
    );
    throw itemsUpdateError;
  }

  // 5. Update batch status
  const { error: batchUpdateError } = await supabase
    .from("import_batches")
    .update({ status: "committed" })
    .eq("id", batchId);

  if (batchUpdateError) {
    console.error(
      `[imports] batch update failed batch_id=${batchId}: ${batchUpdateError.message}`
    );
    throw batchUpdateError;
  }

  // 6. Audit log — uses new_values to store commit metadata (no 'metadata' column in schema)
  const { error: auditError } = await supabase.from("audit_logs").insert({
    entity_type: "import_batch",
    entity_id: batchId,
    action: "commit",
    source: "admin",
    actor_user_id: actorUserId,
    new_values: { committed, skipped },
  });

  if (auditError) {
    console.error(
      `[imports] audit log insert failed batch_id=${batchId}: ${auditError.message}`
    );
    throw auditError;
  }

  // 7. Final structured log
  console.log(
    `[imports] committed batch_id=${batchId} committed=${committed} skipped=${skipped}`
  );

  return { committed, skipped };
}
