import { describe, it, expect } from "vitest";
import { normalizeRow, normalizePhone, validateEnvelope } from "@/features/imports/contract";

describe("normalizePhone", () => {
  it("accepts E.164 format unchanged", () => {
    expect(normalizePhone("+15551234567")).toEqual({ e164: "+15551234567", error: null });
  });

  it("normalizes US 10-digit to E.164", () => {
    expect(normalizePhone("5551234567")).toEqual({ e164: "+15551234567", error: null });
  });

  it("normalizes US 11-digit (leading 1) to E.164", () => {
    expect(normalizePhone("15551234567")).toEqual({ e164: "+15551234567", error: null });
  });

  it("normalizes formatted phone number", () => {
    expect(normalizePhone("(555) 123-4567")).toEqual({ e164: "+15551234567", error: null });
  });

  it("normalizes phone with dashes", () => {
    expect(normalizePhone("555-123-4567")).toEqual({ e164: "+15551234567", error: null });
  });

  it("returns error for non-numeric garbage", () => {
    const { e164, error } = normalizePhone("not-a-phone");
    expect(e164).toBeNull();
    expect(error).toContain("E.164");
  });

  it("returns error for too-short number", () => {
    const { e164, error } = normalizePhone("12345");
    expect(e164).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe("normalizeRow", () => {
  describe("valid rows", () => {
    it("normalizes a fully valid row", () => {
      const result = normalizeRow({
        companyName: "Acme Corp",
        userEmail: "ops@acme.internal",
        phoneNumber: "+15551234567",
      });
      expect(result.status).toBe("valid");
      expect(result.validationError).toBeNull();
      expect(result.companyName).toBe("Acme Corp");
      expect(result.userEmail).toBe("ops@acme.internal");
      expect(result.phoneNumber).toBe("+15551234567");
    });

    it("normalizes US 10-digit phone to E.164", () => {
      const result = normalizeRow({
        companyName: "Acme Corp",
        phoneNumber: "5551234567",
      });
      expect(result.status).toBe("valid");
      expect(result.phoneNumber).toBe("+15551234567");
    });

    it("normalizes a formatted phone number", () => {
      const result = normalizeRow({
        companyName: "Acme Corp",
        phoneNumber: "(555) 123-4567",
      });
      expect(result.status).toBe("valid");
      expect(result.phoneNumber).toBe("+15551234567");
    });

    it("accepts a row without userEmail", () => {
      const result = normalizeRow({
        companyName: "Acme Corp",
        phoneNumber: "+15551234567",
      });
      expect(result.status).toBe("valid");
      expect(result.userEmail).toBeNull();
    });

    it("lowercases userEmail", () => {
      const result = normalizeRow({
        companyName: "Acme",
        userEmail: "OPS@Acme.COM",
        phoneNumber: "+15551234567",
      });
      expect(result.status).toBe("valid");
      expect(result.userEmail).toBe("ops@acme.com");
    });

    it("trims whitespace from companyName", () => {
      const result = normalizeRow({
        companyName: "  Acme Corp  ",
        phoneNumber: "+15551234567",
      });
      expect(result.status).toBe("valid");
      expect(result.companyName).toBe("Acme Corp");
    });

    it("populates normalizedRecord for valid rows", () => {
      const result = normalizeRow({
        companyName: "Acme",
        phoneNumber: "+15551234567",
      });
      expect(result.normalizedRecord).toMatchObject({
        companyName: "Acme",
        phoneNumber: "+15551234567",
        userEmail: null,
      });
    });
  });

  describe("validation_error rows", () => {
    it("rejects a string instead of object", () => {
      const result = normalizeRow("not an object");
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("must be an object");
    });

    it("rejects null", () => {
      const result = normalizeRow(null);
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("must be an object");
    });

    it("rejects an array", () => {
      const result = normalizeRow([]);
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("must be an object");
    });

    it("rejects blank companyName", () => {
      const result = normalizeRow({ companyName: "  ", phoneNumber: "+15551234567" });
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("companyName is required");
    });

    it("rejects missing companyName", () => {
      const result = normalizeRow({ phoneNumber: "+15551234567" });
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("companyName is required");
    });

    it("rejects non-string companyName", () => {
      const result = normalizeRow({ companyName: 42, phoneNumber: "+15551234567" });
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("companyName is required");
    });

    it("rejects blank phoneNumber", () => {
      const result = normalizeRow({ companyName: "Acme", phoneNumber: "   " });
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("phoneNumber is required");
    });

    it("rejects missing phoneNumber", () => {
      const result = normalizeRow({ companyName: "Acme" });
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("phoneNumber is required");
    });

    it("rejects unnormalizable phone number", () => {
      const result = normalizeRow({ companyName: "Acme", phoneNumber: "not-a-phone" });
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("E.164");
    });

    it("rejects malformed userEmail", () => {
      const result = normalizeRow({
        companyName: "Acme",
        userEmail: "not-an-email",
        phoneNumber: "+15551234567",
      });
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("userEmail");
    });

    it("preserves rawRecord reference for invalid rows", () => {
      const raw = { companyName: "", phoneNumber: "bad" };
      const result = normalizeRow(raw);
      expect(result.status).toBe("validation_error");
      expect(result.rawRecord).toBe(raw);
    });

    it("accumulates multiple errors in a single validationError string", () => {
      const result = normalizeRow({ companyName: "", phoneNumber: "" });
      expect(result.status).toBe("validation_error");
      expect(result.validationError).toContain("companyName is required");
      expect(result.validationError).toContain("phoneNumber is required");
    });

    it("returns empty normalizedRecord for invalid rows", () => {
      const result = normalizeRow({ companyName: "", phoneNumber: "" });
      expect(result.normalizedRecord).toEqual({});
    });
  });
});

describe("validateEnvelope", () => {
  it("returns null for a valid envelope", () => {
    expect(
      validateEnvelope({
        sourceRunId: "run-001",
        rows: [{ companyName: "Acme", phoneNumber: "+15551234567" }],
      })
    ).toBeNull();
  });

  it("rejects non-object body", () => {
    expect(validateEnvelope("string")).not.toBeNull();
    expect(validateEnvelope(null)).not.toBeNull();
    expect(validateEnvelope(42)).not.toBeNull();
  });

  it("rejects blank sourceRunId", () => {
    const err = validateEnvelope({ sourceRunId: "  ", rows: [{}] });
    expect(err).toContain("sourceRunId");
  });

  it("rejects missing sourceRunId", () => {
    const err = validateEnvelope({ rows: [{}] });
    expect(err).toContain("sourceRunId");
  });

  it("rejects rows that is not an array", () => {
    const err = validateEnvelope({ sourceRunId: "run-001", rows: "not-array" });
    expect(err).toContain("rows");
  });

  it("rejects empty rows array", () => {
    const err = validateEnvelope({ sourceRunId: "run-001", rows: [] });
    expect(err).toContain("rows");
  });
});
