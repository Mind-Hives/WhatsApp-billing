import { describe, expect, it } from "vitest";
import {
  MAX_TARGETED_PHONE_NUMBERS,
  normalizeTargetedPhoneNumbers,
  normalizeTwilioPhoneNumber,
  toLocalTwilioStatus,
  type LocalTwilioStatus,
} from "@/utils/twilio/status";

describe("toLocalTwilioStatus", () => {
  it("maps Twilio active-like returned statuses to active", () => {
    expect(toLocalTwilioStatus("in-use")).toMatchObject({
      status: "active",
      rawStatus: "in-use",
      isUnexpectedRawStatus: false,
    });
    expect(toLocalTwilioStatus("active").status).toBe("active");
    expect(toLocalTwilioStatus("completed").status).toBe("active");
  });

  it("maps unknown or unexpectedly-shaped returned statuses to inactive with raw diagnostics", () => {
    expect(toLocalTwilioStatus("suspended")).toEqual({
      status: "inactive",
      rawStatus: "suspended",
      isUnexpectedRawStatus: true,
    });
    expect(toLocalTwilioStatus(42)).toEqual({
      status: "inactive",
      rawStatus: null,
      isUnexpectedRawStatus: true,
    });
  });

  it("maps absent returned status conservatively to inactive without producing released", () => {
    const result = toLocalTwilioStatus(undefined);
    expect(result).toEqual({
      status: "inactive",
      rawStatus: null,
      isUnexpectedRawStatus: true,
    });
    expect(result.status).not.toBe("released");
  });
});

describe("normalizeTwilioPhoneNumber", () => {
  it("accepts existing E.164-ish numbers unchanged after trimming", () => {
    expect(normalizeTwilioPhoneNumber("  +15551234567  ")).toEqual({
      e164: "+15551234567",
      error: null,
    });
  });

  it("normalizes formatted US numbers to E.164", () => {
    expect(normalizeTwilioPhoneNumber("(555) 123-4567")).toEqual({
      e164: "+15551234567",
      error: null,
    });
    expect(normalizeTwilioPhoneNumber("1-555-123-4567")).toEqual({
      e164: "+15551234567",
      error: null,
    });
  });

  it("rejects blank and non-string phone numbers without throwing", () => {
    expect(normalizeTwilioPhoneNumber("   ")).toMatchObject({
      e164: null,
      error: expect.stringContaining("non-empty string"),
    });
    expect(normalizeTwilioPhoneNumber(null)).toMatchObject({
      e164: null,
      error: expect.stringContaining("non-empty string"),
    });
  });
});

describe("normalizeTargetedPhoneNumbers", () => {
  it("normalizes and deduplicates targeted phone numbers while preserving first-seen order", () => {
    expect(
      normalizeTargetedPhoneNumbers(["(555) 123-4567", "+15551234567", "+15557654321"])
    ).toEqual({
      numbers: ["+15551234567", "+15557654321"],
      errors: [],
    });
  });

  it("returns per-item validation errors for malformed targeted inputs", () => {
    const result = normalizeTargetedPhoneNumbers(["+15551234567", "", 123]);

    expect(result.numbers).toEqual(["+15551234567"]);
    expect(result.errors).toEqual([
      { index: 1, error: expect.stringContaining("non-empty string") },
      { index: 2, error: expect.stringContaining("non-empty string") },
    ]);
  });

  it("rejects arrays over the targeted validation cap before downstream Twilio or DB work", () => {
    const tooMany = Array.from({ length: MAX_TARGETED_PHONE_NUMBERS + 1 }, (_, index) =>
      `+1555000${String(index).padStart(4, "0")}`
    );

    expect(normalizeTargetedPhoneNumbers(tooMany)).toEqual({
      numbers: [],
      errors: [
        {
          index: null,
          error: `targeted phoneNumbers must contain ${MAX_TARGETED_PHONE_NUMBERS} or fewer entries`,
        },
      ],
    });
  });

  it("keeps the local helper-produced statuses narrower than the database enum", () => {
    const helperStatuses: LocalTwilioStatus[] = [
      toLocalTwilioStatus("in-use").status,
      toLocalTwilioStatus("unexpected").status,
      toLocalTwilioStatus(undefined).status,
    ];

    expect(helperStatuses).toEqual(["active", "inactive", "inactive"]);
    expect(helperStatuses).not.toContain("released");
    expect(helperStatuses).not.toContain("missing");
  });
});
