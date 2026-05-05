import { createAdminClient } from "@/utils/supabase/admin";
import { normalizeRow } from "./contract";

export interface StageBatchInput {
  sourceRunId: string;
  rows: unknown[];
  source?: string;
  payloadVersion?: string;
}

export interface StageBatchResult {
  batchId: string;
  duplicate: boolean;
  rowCount: number;
  validRowCount: number;
  invalidRowCount: number;
}

// Orchestrate first-write vs replay lookup, count calculation, and item persistence.
// Replay is detected via the unique index on (source, source_run_id): a second call with
// the same sourceRunId returns the existing batch summary without inserting anything.
export async function stageBatch(
  input: StageBatchInput
): Promise<StageBatchResult> {
  const { sourceRunId, rows, source = "n8n", payloadVersion } = input;
  const supabase = createAdminClient();

  // Check for an existing batch before any writes (idempotency guard).
  const { data: existing, error: lookupError } = await supabase
    .from("import_batches")
    .select("id, row_count, valid_row_count, invalid_row_count")
    .eq("source", source)
    .eq("source_run_id", sourceRunId)
    .maybeSingle();

  if (lookupError) {
    console.error(
      `[imports] replay lookup failed source_run_id=${sourceRunId}: ${lookupError.message}`
    );
    throw lookupError;
  }

  if (existing) {
    console.log(
      `[imports] replay detected source_run_id=${sourceRunId} batch_id=${existing.id} row_count=${existing.row_count}`
    );
    return {
      batchId: existing.id,
      duplicate: true,
      rowCount: existing.row_count,
      validRowCount: existing.valid_row_count,
      invalidRowCount: existing.invalid_row_count,
    };
  }

  // Normalize all rows up front — malformed rows become validation_error items, not exceptions.
  const normalized = rows.map((row, i) => ({
    index: i,
    result: normalizeRow(row),
  }));
  const validCount = normalized.filter((r) => r.result.status === "valid").length;
  const invalidCount = normalized.length - validCount;

  // Insert the batch header. Counts are set at write time to avoid later O(N) item-table scans.
  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .insert({
      source,
      source_run_id: sourceRunId,
      status: "staged",
      payload_version: payloadVersion ?? null,
      row_count: rows.length,
      valid_row_count: validCount,
      invalid_row_count: invalidCount,
      raw_payload: { rowCount: rows.length },
    })
    .select("id")
    .single();

  if (batchError || !batch) {
    console.error(
      `[imports] batch insert failed source_run_id=${sourceRunId}: ${batchError?.message ?? "no data returned"}`
    );
    throw batchError ?? new Error("[imports] batch insert returned no data");
  }

  // Insert all items in a single round trip — avoids per-row database calls.
  const items = normalized.map(({ index, result }) => ({
    batch_id: batch.id,
    row_index: index,
    status: result.status,
    validation_error: result.validationError ?? null,
    raw_record: result.rawRecord as object ?? {},
    normalized_record: result.normalizedRecord,
    company_name: result.companyName,
    user_email: result.userEmail,
    phone_number: result.phoneNumber,
  }));

  const { error: itemsError } = await supabase
    .from("import_items")
    .insert(items);

  if (itemsError) {
    console.error(
      `[imports] items insert failed batch_id=${batch.id} source_run_id=${sourceRunId}: ${itemsError.message}`
    );
    throw itemsError;
  }

  console.log(
    `[imports] staged batch_id=${batch.id} source_run_id=${sourceRunId} row_count=${rows.length} valid=${validCount} invalid=${invalidCount}`
  );

  return {
    batchId: batch.id,
    duplicate: false,
    rowCount: rows.length,
    validRowCount: validCount,
    invalidRowCount: invalidCount,
  };
}
