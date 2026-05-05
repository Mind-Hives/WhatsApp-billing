// Normalization and validation contract for incoming import rows.
// No Supabase or Next.js imports — pure data logic, safe in any context.

export interface RawImportRow {
  companyName?: unknown;
  userEmail?: unknown;
  phoneNumber?: unknown;
  [key: string]: unknown;
}

export type RowStatus = "valid" | "validation_error";

export interface RowValidationResult {
  status: RowStatus;
  validationError: string | null;
  rawRecord: unknown;
  normalizedRecord: Record<string, unknown>;
  companyName: string | null;
  userEmail: string | null;
  phoneNumber: string | null;
}

// Attempt to normalize a phone string to E.164 (+<digits>).
// Accepts: already-E.164, 10-digit US, 11-digit US with leading 1, formatted variants.
export function normalizePhone(raw: string): {
  e164: string | null;
  error: string | null;
} {
  const stripped = raw.replace(/[\s\-().+]/g, "");

  // Reconstruct + prefix for E.164 test after stripping
  const withPlus = raw.trim().startsWith("+") ? `+${stripped}` : stripped;

  if (/^\+\d{7,15}$/.test(withPlus)) {
    return { e164: withPlus, error: null };
  }

  if (/^\d{10}$/.test(stripped)) {
    return { e164: `+1${stripped}`, error: null };
  }

  if (/^1\d{10}$/.test(stripped)) {
    return { e164: `+${stripped}`, error: null };
  }

  return {
    e164: null,
    error: "phoneNumber cannot be normalized to E.164 format",
  };
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Normalize and validate one raw import row.
// Returns a RowValidationResult with deterministic validation_error messages
// for every field problem. Never throws — malformed input produces validation_error status.
export function normalizeRow(raw: unknown): RowValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      status: "validation_error",
      validationError: "row must be an object",
      rawRecord: raw,
      normalizedRecord: {},
      companyName: null,
      userEmail: null,
      phoneNumber: null,
    };
  }

  const row = raw as RawImportRow;
  const errors: string[] = [];

  // companyName: required, non-blank
  const companyName =
    typeof row.companyName === "string" ? row.companyName.trim() : "";
  if (!companyName) {
    errors.push("companyName is required");
  }

  // phoneNumber: required, must normalize to E.164
  const rawPhone =
    typeof row.phoneNumber === "string" ? row.phoneNumber.trim() : "";
  let phoneNumber: string | null = null;
  if (!rawPhone) {
    errors.push("phoneNumber is required");
  } else {
    const { e164, error } = normalizePhone(rawPhone);
    if (error) {
      errors.push(error);
    } else {
      phoneNumber = e164;
    }
  }

  // userEmail: optional, but must be valid if present
  const rawEmail =
    typeof row.userEmail === "string" ? row.userEmail.trim() : null;
  let userEmail: string | null = null;
  if (rawEmail) {
    if (!isValidEmail(rawEmail)) {
      errors.push("userEmail is not a valid email address");
    } else {
      userEmail = rawEmail.toLowerCase();
    }
  }

  if (errors.length > 0) {
    return {
      status: "validation_error",
      validationError: errors.join("; "),
      rawRecord: raw,
      normalizedRecord: {},
      companyName: companyName || null,
      userEmail: null,
      phoneNumber: null,
    };
  }

  const normalizedRecord: Record<string, unknown> = {
    companyName,
    userEmail,
    phoneNumber,
  };

  return {
    status: "valid",
    validationError: null,
    rawRecord: raw,
    normalizedRecord,
    companyName,
    userEmail,
    phoneNumber,
  };
}

// Validate the request envelope fields (not per-row data).
// Returns null when valid, or a human-readable error string.
export function validateEnvelope(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "request body must be a JSON object";
  }

  const b = body as Record<string, unknown>;

  if (typeof b.sourceRunId !== "string" || !b.sourceRunId.trim()) {
    return "sourceRunId is required and must be a non-empty string";
  }

  if (!Array.isArray(b.rows)) {
    return "rows must be an array";
  }

  if (b.rows.length === 0) {
    return "rows must not be empty";
  }

  return null;
}
