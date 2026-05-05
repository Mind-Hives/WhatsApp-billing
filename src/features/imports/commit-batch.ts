import { createAdminClient } from "@/utils/supabase/admin";
import type { NormalizedImportRow } from "./contract";

export interface CommitBatchInput {
  batchId: string;
  actorUserId: string;
}

export interface CommitBatchResult {
  committed: number;
  skipped: number;
}

type CompanyRow = { id: string; name: string };
type EmployeeRow = { id: string; company_id: string; full_name: string; email: string | null };
type PhoneNumberRow = { id: string; e164_number: string };
type AssignmentRow = {
  id: string;
  phone_number_id: string;
  employee_id: string | null;
  company_id: string;
};

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function findOrCreateCompany(
  supabase: ReturnType<typeof createAdminClient>,
  row: NormalizedImportRow
) {
  const { data: existing, error: findError } = await supabase
    .from("companies")
    .select("id, name")
    .ilike("name", escapeLike(row.company_name))
    .maybeSingle<CompanyRow>();
  if (findError) {
    throw findError;
  }
  if (existing) {
    return existing;
  }

  const { data, error } = await supabase
    .from("companies")
    .insert({
      name: row.company_name,
      billing_status: "active",
      lago_external_customer_id: null,
    })
    .select("id, name")
    .single<CompanyRow>();
  if (error || !data) {
    throw error ?? new Error("Company insert returned no row");
  }
  return data;
}

async function findOrCreateEmployee(
  supabase: ReturnType<typeof createAdminClient>,
  companyId: string,
  row: NormalizedImportRow
) {
  let query = supabase
    .from("employees")
    .select("id, company_id, full_name, email")
    .eq("company_id", companyId);

  query = row.employee_email
    ? query.eq("email", row.employee_email)
    : query.ilike("full_name", escapeLike(row.employee_name ?? ""));

  const { data: existing, error: findError } = await query.maybeSingle<EmployeeRow>();
  if (findError) {
    throw findError;
  }
  if (existing) {
    const { data, error } = await supabase
      .from("employees")
      .update({
        full_name: row.employee_name ?? existing.full_name,
        working_location: row.working_location,
        department: row.department,
        status: "active",
      })
      .eq("id", existing.id)
      .select("id, company_id, full_name, email")
      .single<EmployeeRow>();
    if (error || !data) {
      throw error ?? new Error("Employee update returned no row");
    }
    return data;
  }

  const { data, error } = await supabase
    .from("employees")
    .insert({
      company_id: companyId,
      full_name: row.employee_name ?? row.employee_email ?? "Unknown employee",
      email: row.employee_email,
      working_location: row.working_location,
      department: row.department,
      status: "active",
    })
    .select("id, company_id, full_name, email")
    .single<EmployeeRow>();
  if (error || !data) {
    throw error ?? new Error("Employee insert returned no row");
  }
  return data;
}

async function findOrCreatePhoneNumber(
  supabase: ReturnType<typeof createAdminClient>,
  row: NormalizedImportRow
) {
  const { data, error } = await supabase
    .from("phone_numbers")
    .upsert(
      {
        e164_number: row.phone_number,
        twilio_sid: row.twilio_sid,
        billing_status: row.billing_status,
        notes: row.notes,
      },
      { onConflict: "e164_number" }
    )
    .select("id, e164_number")
    .single<PhoneNumberRow>();
  if (error || !data) {
    throw error ?? new Error("Phone number upsert returned no row");
  }
  return data;
}

async function getActiveAssignment(
  supabase: ReturnType<typeof createAdminClient>,
  phoneNumberId: string
) {
  const { data, error } = await supabase
    .from("number_assignments")
    .select("id, phone_number_id, company_id, employee_id")
    .eq("phone_number_id", phoneNumberId)
    .eq("status", "active")
    .is("assigned_to", null)
    .maybeSingle<AssignmentRow>();
  if (error) {
    throw error;
  }
  return data;
}

export async function commitBatch(
  input: CommitBatchInput
): Promise<CommitBatchResult> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select("id, status")
    .eq("id", input.batchId)
    .maybeSingle<{ id: string; status: string }>();
  if (batchError) {
    throw batchError;
  }
  if (!batch || !["pending_review", "not_committable"].includes(batch.status)) {
    return { committed: 0, skipped: 0 };
  }

  const { data: items, error: itemsError } = await supabase
    .from("import_items")
    .select("id, normalized_row, status")
    .eq("batch_id", input.batchId)
    .eq("status", "ready");
  if (itemsError) {
    throw itemsError;
  }

  let committed = 0;
  let skipped = 0;

  for (const item of items ?? []) {
    const row = item.normalized_row as NormalizedImportRow;
    const company = await findOrCreateCompany(supabase, row);
    const employee = await findOrCreateEmployee(supabase, company.id, row);
    const phoneNumber = await findOrCreatePhoneNumber(supabase, row);
    const activeAssignment = await getActiveAssignment(supabase, phoneNumber.id);

    if (
      activeAssignment &&
      activeAssignment.company_id === company.id &&
      activeAssignment.employee_id === employee.id
    ) {
      skipped += 1;
    } else {
      if (activeAssignment) {
        const { error: closeError } = await supabase
          .from("number_assignments")
          .update({ assigned_to: now, status: "ended" })
          .eq("id", activeAssignment.id);
        if (closeError) {
          throw closeError;
        }
      }

      const { error: assignmentError } = await supabase
        .from("number_assignments")
        .insert({
          phone_number_id: phoneNumber.id,
          employee_id: employee.id,
          company_id: company.id,
          assigned_from: now,
          status: "active",
          source: "csv",
        });
      if (assignmentError) {
        throw assignmentError;
      }
      committed += 1;
    }

    const { error: itemUpdateError } = await supabase
      .from("import_items")
      .update({ status: "committed" })
      .eq("id", item.id);
    if (itemUpdateError) {
      throw itemUpdateError;
    }
  }

  const { error: batchUpdateError } = await supabase
    .from("import_batches")
    .update({
      status: "committed",
      committed_at: new Date().toISOString(),
    })
    .eq("id", input.batchId);
  if (batchUpdateError) {
    throw batchUpdateError;
  }

  await supabase.from("audit_logs").insert({
    actor_type: "admin",
    actor_id: input.actorUserId,
    action: "csv_import_commit",
    entity_type: "import_batch",
    entity_id: input.batchId,
    source: "csv",
    new_values: { committed, skipped },
  });

  return { committed, skipped };
}
