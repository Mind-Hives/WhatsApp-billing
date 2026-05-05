// Pure Twilio status and targeted-number helpers for the admin sync boundary.
// No Twilio client, Supabase, or Next.js imports here — this module is safe to unit test
// and safe to share with server-only sync code without risking credential exposure.

export const MAX_TARGETED_PHONE_NUMBERS = 200;

export type DatabaseTwilioStatus = "unknown" | "active" | "inactive" | "missing" | "released";

// S04 helpers only translate statuses for phone numbers Twilio returned. Missing/released
// transitions are determined by the sync diff, not by raw Twilio instance statuses.
export type LocalTwilioStatus = Exclude<DatabaseTwilioStatus, "unknown" | "missing" | "released">;

export interface TwilioStatusMapping {
  status: LocalTwilioStatus;
  rawStatus: string | null;
  isUnexpectedRawStatus: boolean;
}

export interface PhoneNormalizationResult {
  e164: string | null;
  error: string | null;
}

export interface TargetedPhoneNumberError {
  index: number | null;
  error: string;
}

export interface TargetedPhoneNumbersResult {
  numbers: string[];
  errors: TargetedPhoneNumberError[];
}

const ACTIVE_LIKE_TWILIO_STATUSES = new Set([
  "active",
  "completed",
  "in-use",
]);

export function toLocalTwilioStatus(rawStatus: unknown): TwilioStatusMapping {
  if (typeof rawStatus !== "string") {
    return {
      status: "inactive",
      rawStatus: null,
      isUnexpectedRawStatus: true,
    };
  }

  const normalizedRawStatus = rawStatus.trim().toLowerCase();

  if (ACTIVE_LIKE_TWILIO_STATUSES.has(normalizedRawStatus)) {
    return {
      status: "active",
      rawStatus: normalizedRawStatus,
      isUnexpectedRawStatus: false,
    };
  }

  return {
    status: "inactive",
    rawStatus: normalizedRawStatus || null,
    isUnexpectedRawStatus: true,
  };
}

export function normalizeTwilioPhoneNumber(rawPhoneNumber: unknown): PhoneNormalizationResult {
  if (typeof rawPhoneNumber !== "string" || !rawPhoneNumber.trim()) {
    return {
      e164: null,
      error: "phoneNumber must be a non-empty string",
    };
  }

  const trimmed = rawPhoneNumber.trim();
  const digits = trimmed.replace(/[^\d]/g, "");

  if (trimmed.startsWith("+") && /^\+\d{7,15}$/.test(`+${digits}`)) {
    return { e164: `+${digits}`, error: null };
  }

  if (/^\d{10}$/.test(digits)) {
    return { e164: `+1${digits}`, error: null };
  }

  if (/^1\d{10}$/.test(digits)) {
    return { e164: `+${digits}`, error: null };
  }

  return {
    e164: null,
    error: "phoneNumber cannot be normalized to E.164 format",
  };
}

export function normalizeTargetedPhoneNumbers(
  rawPhoneNumbers: unknown,
  maxPhoneNumbers = MAX_TARGETED_PHONE_NUMBERS
): TargetedPhoneNumbersResult {
  if (!Array.isArray(rawPhoneNumbers)) {
    return {
      numbers: [],
      errors: [{ index: null, error: "phoneNumbers must be an array" }],
    };
  }

  if (rawPhoneNumbers.length > maxPhoneNumbers) {
    return {
      numbers: [],
      errors: [
        {
          index: null,
          error: `targeted phoneNumbers must contain ${maxPhoneNumbers} or fewer entries`,
        },
      ],
    };
  }

  const seen = new Set<string>();
  const numbers: string[] = [];
  const errors: TargetedPhoneNumberError[] = [];

  rawPhoneNumbers.forEach((rawPhoneNumber, index) => {
    const { e164, error } = normalizeTwilioPhoneNumber(rawPhoneNumber);

    if (error || !e164) {
      errors.push({ index, error: error ?? "phoneNumber cannot be normalized" });
      return;
    }

    if (!seen.has(e164)) {
      seen.add(e164);
      numbers.push(e164);
    }
  });

  return { numbers, errors };
}
