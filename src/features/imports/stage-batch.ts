import { createAdminClient } from "@/utils/supabase/admin";
import {
  parseCsv,
  validateRows,
  type DetectedChangeType,
  type NormalizedImportRow,
} from "./contract";

export interface StageCsvBatchInput {
  filename: string;
  csvText: string;
  uploadedBy: string | null;
}

export interface StageCsvBatchResult {
  batchId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
}

export interface StageBatchInput {
  sourceRunId: string;
  rows: unknown[];
  source?: string;
}

export interface StageBatchResult {
  batchId: string;
  duplicate: boolean;
  rowCount: number;
  validRowCount: number;
  invalidRowCount: number;
}

type ExistingCompany = { id: string; name: string };
type ExistingEmployee = { id: string; company_id: string; email: string | null; full_name: string };
type ExistingNumber = {
  id: string;
  e164_number: string;
  number_assignments: Array<{
    id: string;
    company_id: string;
    employee_id: string | null;
    status: string;
  }>;
};

function key(value: string) {
  return value.trim().toLowerCase();
}

function employeeKey(row: NormalizedImportRow, companyId: string | null) {
  if (!companyId) {
    return null;
  }
  return row.employee_email
    ? `${companyId}:email:${row.employee_email}`
    : `${companyId}:name:${key(row.employee_name ?? "")}`;
}

function detectChangeType(
  row: NormalizedImportRow,
  context: {
    companies: Map<string, ExistingCompany>;
    employees: Map<string, ExistingEmployee>;
    numbers: Map<string, ExistingNumber>;
  }
): DetectedChangeType {
  const company = context.companies.get(key(row.company_name));
  if (!company) {
    return "new_company";
  }

  const employeeLookupKey = employeeKey(row, company.id);
  if (employeeLookupKey && !context.employees.has(employeeLookupKey)) {
    return "new_employee";
  }

  const number = context.numbers.get(row.phone_number);
  if (!number) {
    return "new_number";
  }

  const activeAssignment = number.number_assignments?.[0];
  if (!activeAssignment) {
    return "reassignment";
  }

  const employee = employeeLookupKey ? context.employees.get(employeeLookupKey) : null;
  if (
    activeAssignment.company_id === company.id &&
    activeAssignment.employee_id === (employee?.id ?? null)
  ) {
    return "unchanged";
  }

  return "reassignment";
}

function legacyRowToCsvRow(row: unknown) {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return row;
  }

  const record = row as Record<string, unknown>;
  return {
    ...record,
    phone_number: record.phone_number ?? record.phoneNumber,
    employee_name: record.employee_name ?? record.employeeName ?? null,
    employee_email: record.employee_email ?? record.userEmail,
    company_name: record.company_name ?? record.companyName,
    working_location: record.working_location ?? record.workingLocation,
    billing_status: record.billing_status ?? "billable",
  };
}

async function stageRows(input: {
  filename: string;
  source: string;
  rawRows: unknown[];
  uploadedBy: string | null;
  rowNumberOffset: number;
  checkDuplicate: boolean;
}): Promise<StageCsvBatchResult & { duplicate: boolean }> {
  const supabase = createAdminClient();
  const validation = validateRows(input.rawRows);

  if (input.checkDuplicate) {
    const { data: existing, error: lookupError } = await supabase
      .from("import_batches")
      .select("id, total_rows, valid_rows, invalid_rows, duplicate_rows")
      .eq("source", input.source)
      .eq("filename", input.filename)
      .maybeSingle();

    if (lookupError) {
      throw lookupError;
    }

    if (existing) {
      return {
        batchId: existing.id,
        totalRows: existing.total_rows,
        validRows: existing.valid_rows,
        invalidRows: existing.invalid_rows,
        duplicateRows: existing.duplicate_rows,
        duplicate: true,
      };
    }
  }

  const readyRows = validation.rows
    .map((result) => result.normalizedRow)
    .filter((row): row is NormalizedImportRow => Boolean(row));

  const companyNames = [...new Set(readyRows.map((row) => row.company_name))];
  const phoneNumbers = [...new Set(readyRows.map((row) => row.phone_number))];

  const { data: companies, error: companiesError } = companyNames.length
    ? await supabase.from("companies").select("id, name").in("name", companyNames)
    : { data: [], error: null };
  if (companiesError) {
    throw companiesError;
  }

  const companyMap = new Map(
    ((companies ?? []) as ExistingCompany[]).map((company) => [key(company.name), company])
  );
  const companyIds = [...companyMap.values()].map((company) => company.id);

  const { data: employees, error: employeesError } = companyIds.length
    ? await supabase
        .from("employees")
        .select("id, company_id, email, full_name")
        .in("company_id", companyIds)
    : { data: [], error: null };
  if (employeesError) {
    throw employeesError;
  }

  const employeeMap = new Map<string, ExistingEmployee>();
  for (const employee of (employees ?? []) as ExistingEmployee[]) {
    if (employee.email) {
      employeeMap.set(`${employee.company_id}:email:${employee.email.toLowerCase()}`, employee);
    }
    employeeMap.set(`${employee.company_id}:name:${key(employee.full_name)}`, employee);
  }

  const { data: numbers, error: numbersError } = phoneNumbers.length
    ? await supabase
        .from("phone_numbers")
        .select("id, e164_number, number_assignments(id, company_id, employee_id, status)")
        .in("e164_number", phoneNumbers)
        .eq("number_assignments.status", "active")
    : { data: [], error: null };
  if (numbersError) {
    throw numbersError;
  }

  const numberMap = new Map(
    ((numbers ?? []) as ExistingNumber[]).map((number) => [number.e164_number, number])
  );

  const items = validation.rows.map((result, index) => {
    const detectedChangeType =
      result.detectedChangeType ??
      (result.normalizedRow
        ? detectChangeType(result.normalizedRow, {
            companies: companyMap,
            employees: employeeMap,
            numbers: numberMap,
          })
        : null);

    return {
      row_number: index + input.rowNumberOffset,
      raw_row: result.rawRow ?? {},
      normalized_row: result.normalizedRow ?? {},
      status: result.status,
      error_messages: result.errorMessages,
      detected_change_type: detectedChangeType,
    };
  });

  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .insert({
      filename: input.filename,
      source: input.source,
      status: validation.validRows > 0 ? "pending_review" : "not_committable",
      total_rows: validation.totalRows,
      valid_rows: validation.validRows,
      invalid_rows: validation.invalidRows,
      duplicate_rows: validation.duplicateRows,
      uploaded_by: input.uploadedBy,
    })
    .select("id")
    .single();

  if (batchError || !batch) {
    throw batchError ?? new Error("Failed to create import batch");
  }

  const { error: itemsError } = await supabase.from("import_items").insert(
    items.map((item) => ({
      ...item,
      batch_id: batch.id,
    }))
  );
  if (itemsError) {
    throw itemsError;
  }

  return {
    batchId: batch.id,
    totalRows: validation.totalRows,
    validRows: validation.validRows,
    invalidRows: validation.invalidRows,
    duplicateRows: validation.duplicateRows,
    duplicate: false,
  };
}

export async function stageCsvBatch(
  input: StageCsvBatchInput
): Promise<StageCsvBatchResult> {
  const result = await stageRows({
    filename: input.filename,
    source: "csv",
    rawRows: parseCsv(input.csvText),
    uploadedBy: input.uploadedBy,
    rowNumberOffset: 2,
    checkDuplicate: false,
  });

  return {
    batchId: result.batchId,
    totalRows: result.totalRows,
    validRows: result.validRows,
    invalidRows: result.invalidRows,
    duplicateRows: result.duplicateRows,
  };
}

export async function stageBatch(
  input: StageBatchInput
): Promise<StageBatchResult> {
  const result = await stageRows({
    filename: input.sourceRunId,
    source: input.source ?? "n8n",
    rawRows: input.rows.map(legacyRowToCsvRow),
    uploadedBy: null,
    rowNumberOffset: 1,
    checkDuplicate: true,
  });

  return {
    batchId: result.batchId,
    duplicate: result.duplicate,
    rowCount: result.totalRows,
    validRowCount: result.validRows,
    invalidRowCount: result.invalidRows,
  };
}
