import { describe, it, expect } from "vitest";
import {
  normalizePhone,
  normalizeRow,
  parseCsv,
  validateEnvelope,
  validateRows,
} from "@/features/imports/contract";

describe("normalizePhone", () => {
  it("accepts E.164 format unchanged", () => {
    expect(normalizePhone("+15551234567")).toEqual({
      e164: "+15551234567",
      error: null,
    });
  });

  it("normalizes US 10-digit to E.164", () => {
    expect(normalizePhone("5551234567")).toEqual({
      e164: "+15551234567",
      error: null,
    });
  });

  it("normalizes US 11-digit with leading 1 to E.164", () => {
    expect(normalizePhone("15551234567")).toEqual({
      e164: "+15551234567",
      error: null,
    });
  });

  it("normalizes formatted phone numbers", () => {
    expect(normalizePhone("(555) 123-4567")).toEqual({
      e164: "+15551234567",
      error: null,
    });
    expect(normalizePhone("555-123-4567")).toEqual({
      e164: "+15551234567",
      error: null,
    });
  });

  it("returns errors for unnormalizable phone values", () => {
    expect(normalizePhone("not-a-phone").error).toContain("E.164");
    expect(normalizePhone("12345").error).not.toBeNull();
  });
});

describe("parseCsv", () => {
  it("parses headers, rows, and quoted commas", () => {
    expect(
      parseCsv('phone_number,company_name,notes\n5551234567,Acme,"main, line"')
    ).toEqual([
      {
        phone_number: "5551234567",
        company_name: "Acme",
        notes: "main, line",
      },
    ]);
  });
});

describe("normalizeRow", () => {
  it("normalizes a fully valid CSV row", () => {
    const result = normalizeRow({
      company_name: " Acme Corp ",
      employee_name: "Ada Lovelace",
      employee_email: "ADA@ACME.COM",
      phone_number: "5551234567",
      working_location: "NYC",
      department: "Ops",
      billing_status: "billable",
    });

    expect(result.status).toBe("ready");
    expect(result.errorMessages).toEqual([]);
    expect(result.normalizedRow).toMatchObject({
      company_name: "Acme Corp",
      employee_name: "Ada Lovelace",
      employee_email: "ada@acme.com",
      phone_number: "+15551234567",
      working_location: "NYC",
      department: "Ops",
      billing_status: "billable",
    });
  });

  it("accepts employee name without email and defaults billing_status", () => {
    const result = normalizeRow({
      company_name: "Acme",
      employee_name: "Ada Lovelace",
      phone_number: "+15551234567",
    });

    expect(result.status).toBe("ready");
    expect(result.normalizedRow).toMatchObject({
      employee_email: null,
      billing_status: "billable",
    });
  });

  it("accepts employee email without name", () => {
    const result = normalizeRow({
      company_name: "Acme",
      employee_email: "ops@acme.internal",
      phone_number: "+15551234567",
    });

    expect(result.status).toBe("ready");
    expect(result.normalizedRow?.employee_name).toBeNull();
    expect(result.normalizedRow?.employee_email).toBe("ops@acme.internal");
  });

  it("rejects non-object rows", () => {
    const result = normalizeRow("not an object");
    expect(result.status).toBe("validation_error");
    expect(result.errorMessages).toContain("row must be an object");
    expect(result.normalizedRow).toBeNull();
  });

  it("accumulates validation errors", () => {
    const result = normalizeRow({
      company_name: "",
      phone_number: "",
      billing_status: "maybe",
    });

    expect(result.status).toBe("validation_error");
    expect(result.errorMessages).toContain("company_name is required");
    expect(result.errorMessages).toContain("phone_number is required");
    expect(result.errorMessages).toContain(
      "employee_name or employee_email is required"
    );
    expect(result.errorMessages).toContain(
      "billing_status must be billable, excluded, suspended, or non_billable"
    );
  });

  it("rejects malformed employee_email", () => {
    const result = normalizeRow({
      company_name: "Acme",
      employee_email: "not-an-email",
      phone_number: "+15551234567",
    });

    expect(result.status).toBe("validation_error");
    expect(result.errorMessages).toContain(
      "employee_email is not a valid email address"
    );
  });
});

describe("validateRows", () => {
  it("marks duplicate phone numbers inside a batch", () => {
    const result = validateRows([
      {
        company_name: "Acme",
        employee_name: "Ada",
        phone_number: "5551234567",
      },
      {
        company_name: "Acme",
        employee_name: "Grace",
        phone_number: "+15551234567",
      },
    ]);

    expect(result.totalRows).toBe(2);
    expect(result.validRows).toBe(1);
    expect(result.invalidRows).toBe(1);
    expect(result.duplicateRows).toBe(1);
    expect(result.rows[1]?.detectedChangeType).toBe("duplicate");
  });
});

describe("validateEnvelope", () => {
  it("returns null for a valid legacy n8n envelope", () => {
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

  it("rejects invalid sourceRunId and rows fields", () => {
    expect(validateEnvelope({ sourceRunId: "  ", rows: [{}] })).toContain(
      "sourceRunId"
    );
    expect(validateEnvelope({ rows: [{}] })).toContain("sourceRunId");
    expect(validateEnvelope({ sourceRunId: "run-001", rows: "no" })).toContain(
      "rows"
    );
    expect(validateEnvelope({ sourceRunId: "run-001", rows: [] })).toContain(
      "rows"
    );
  });
});
