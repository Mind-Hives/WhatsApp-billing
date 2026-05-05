export type BillingStatus =
  | "billable"
  | "excluded"
  | "suspended"
  | "non_billable";

export type ImportItemStatus = "ready" | "validation_error";

export type DetectedChangeType =
  | "new_number"
  | "new_company"
  | "new_employee"
  | "reassignment"
  | "unchanged"
  | "duplicate";

export interface CsvImportRow {
  phone_number?: unknown;
  employee_name?: unknown;
  employee_email?: unknown;
  company_name?: unknown;
  working_location?: unknown;
  billing_status?: unknown;
  department?: unknown;
  twilio_sid?: unknown;
  notes?: unknown;
  [key: string]: unknown;
}

export interface NormalizedImportRow {
  phone_number: string;
  employee_name: string | null;
  employee_email: string | null;
  company_name: string;
  working_location: string | null;
  billing_status: BillingStatus;
  department: string | null;
  twilio_sid: string | null;
  notes: string | null;
}

export interface RowValidationResult {
  status: ImportItemStatus;
  rawRow: unknown;
  normalizedRow: NormalizedImportRow | null;
  errorMessages: string[];
  detectedChangeType?: DetectedChangeType;
}

export interface BatchValidationResult {
  rows: RowValidationResult[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
}

const BILLING_STATUSES = new Set<BillingStatus>([
  "billable",
  "excluded",
  "suspended",
  "non_billable",
]);

export function normalizePhone(raw: string): {
  e164: string | null;
  error: string | null;
} {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");

  if (/^\+\d{7,15}$/.test(trimmed.replace(/[\s\-().]/g, ""))) {
    return { e164: trimmed.replace(/[\s\-().]/g, ""), error: null };
  }

  if (/^\d{10}$/.test(digits)) {
    return { e164: `+1${digits}`, error: null };
  }

  if (/^1\d{10}$/.test(digits)) {
    return { e164: `+${digits}`, error: null };
  }

  if (/^\d{7,15}$/.test(digits) && trimmed.startsWith("+")) {
    return { e164: `+${digits}`, error: null };
  }

  return {
    e164: null,
    error: "phone_number cannot be normalized to E.164 format",
  };
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [headerRow, ...dataRows] = rows.filter((r) =>
    r.some((cell) => cell.trim() !== "")
  );
  if (!headerRow) {
    return [];
  }

  const headers = headerRow.map((header) => header.trim());
  return dataRows.map((dataRow) =>
    Object.fromEntries(headers.map((header, index) => [header, dataRow[index]?.trim() ?? ""]))
  );
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeEmail(value: unknown) {
  const email = optionalString(value);
  if (!email) {
    return { email: null, error: null };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { email: null, error: "employee_email is not a valid email address" };
  }
  return { email: email.toLowerCase(), error: null };
}

export function normalizeRow(raw: unknown): RowValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      status: "validation_error",
      rawRow: raw,
      normalizedRow: null,
      errorMessages: ["row must be an object"],
    };
  }

  const row = raw as CsvImportRow;
  const errors: string[] = [];
  const rawPhone = optionalString(row.phone_number);
  const companyName = optionalString(row.company_name);
  const employeeName = optionalString(row.employee_name);
  const emailResult = normalizeEmail(row.employee_email);
  const workingLocation = optionalString(row.working_location);
  const department = optionalString(row.department);
  const twilioSid = optionalString(row.twilio_sid);
  const notes = optionalString(row.notes);
  const billingStatusRaw = optionalString(row.billing_status)?.toLowerCase() ?? "billable";
  let phoneNumber: string | null = null;

  if (!rawPhone) {
    errors.push("phone_number is required");
  } else {
    const phoneResult = normalizePhone(rawPhone);
    if (phoneResult.error) {
      errors.push(phoneResult.error);
    } else {
      phoneNumber = phoneResult.e164;
    }
  }

  if (!companyName) {
    errors.push("company_name is required");
  }

  if (!employeeName && !emailResult.email) {
    errors.push("employee_name or employee_email is required");
  }

  if (emailResult.error) {
    errors.push(emailResult.error);
  }

  if (!BILLING_STATUSES.has(billingStatusRaw as BillingStatus)) {
    errors.push("billing_status must be billable, excluded, suspended, or non_billable");
  }

  if (errors.length > 0 || !phoneNumber || !companyName) {
    return {
      status: "validation_error",
      rawRow: raw,
      normalizedRow: null,
      errorMessages: errors,
    };
  }

  return {
    status: "ready",
    rawRow: raw,
    normalizedRow: {
      phone_number: phoneNumber,
      employee_name: employeeName,
      employee_email: emailResult.email,
      company_name: companyName,
      working_location: workingLocation,
      billing_status: billingStatusRaw as BillingStatus,
      department,
      twilio_sid: twilioSid,
      notes,
    },
    errorMessages: [],
  };
}

export function validateRows(rows: unknown[]): BatchValidationResult {
  const seen = new Map<string, number>();
  const normalizedRows = rows.map((row) => normalizeRow(row));

  for (const [index, result] of normalizedRows.entries()) {
    const phoneNumber = result.normalizedRow?.phone_number;
    if (!phoneNumber) {
      continue;
    }
    const firstSeen = seen.get(phoneNumber);
    if (firstSeen === undefined) {
      seen.set(phoneNumber, index);
      continue;
    }

    result.status = "validation_error";
    result.errorMessages = [
      ...result.errorMessages,
      `duplicate phone_number in CSV; first seen on row ${firstSeen + 2}`,
    ];
    result.detectedChangeType = "duplicate";
  }

  const validRows = normalizedRows.filter((row) => row.status === "ready").length;
  const duplicateRows = normalizedRows.filter(
    (row) => row.detectedChangeType === "duplicate"
  ).length;

  return {
    rows: normalizedRows,
    totalRows: normalizedRows.length,
    validRows,
    invalidRows: normalizedRows.length - validRows,
    duplicateRows,
  };
}

export function validateEnvelope(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "request body must be a JSON object";
  }

  const envelope = body as Record<string, unknown>;

  if (
    typeof envelope.sourceRunId !== "string" ||
    !envelope.sourceRunId.trim()
  ) {
    return "sourceRunId is required and must be a non-empty string";
  }

  if (!Array.isArray(envelope.rows)) {
    return "rows must be an array";
  }

  if (envelope.rows.length === 0) {
    return "rows must not be empty";
  }

  return null;
}
