// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock stage-batch before importing the route so the mock is in place on first import.
vi.mock("@/features/imports/stage-batch", () => ({
  stageBatch: vi.fn(),
}));

// Mock the admin client to prevent startup env checks during import.
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({})),
}));

import { POST } from "@/app/api/imports/n8n/route";
import { stageBatch } from "@/features/imports/stage-batch";

const mockStageBatch = vi.mocked(stageBatch);

const VALID_SECRET = "test-bearer-secret";

const VALID_BODY = {
  sourceRunId: "run-abc-001",
  rows: [
    { companyName: "Acme Corp", phoneNumber: "5551234567", userEmail: "a@acme.com" },
  ],
};

function makeRequest(
  body: unknown,
  { secret = VALID_SECRET, contentType = "application/json" }: { secret?: string | null; contentType?: string } = {}
) {
  const headers: Record<string, string> = { "content-type": contentType };
  if (secret !== null) {
    headers["authorization"] = `Bearer ${secret}`;
  }
  return new Request("http://localhost/api/imports/n8n", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeStageResult(overrides: Partial<Awaited<ReturnType<typeof stageBatch>>> = {}) {
  return {
    batchId: "batch-uuid-001",
    duplicate: false,
    rowCount: 1,
    validRowCount: 1,
    invalidRowCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("N8N_IMPORT_SECRET", VALID_SECRET);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  mockStageBatch.mockResolvedValue(makeStageResult());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/imports/n8n — auth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const req = makeRequest(VALID_BODY, { secret: null });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/unauthorized/i);
    expect(mockStageBatch).not.toHaveBeenCalled();
  });

  it("returns 401 when bearer secret is wrong", async () => {
    const req = makeRequest(VALID_BODY, { secret: "wrong-secret" });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(mockStageBatch).not.toHaveBeenCalled();
  });

  it("returns 401 when N8N_IMPORT_SECRET env var is not set", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("N8N_IMPORT_SECRET", "");
    const req = makeRequest(VALID_BODY);
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(mockStageBatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/imports/n8n — body parsing", () => {
  it("returns 400 for invalid JSON body", async () => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_SECRET}`,
    };
    const req = new Request("http://localhost/api/imports/n8n", {
      method: "POST",
      headers,
      body: "not-valid-json{{{",
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid json/i);
    expect(mockStageBatch).not.toHaveBeenCalled();
  });

  it("returns 422 for missing sourceRunId", async () => {
    const req = makeRequest({ rows: [{ companyName: "A", phoneNumber: "5551234567" }] });
    const res = await POST(req as never);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/sourceRunId/);
    expect(mockStageBatch).not.toHaveBeenCalled();
  });

  it("returns 422 for blank sourceRunId", async () => {
    const req = makeRequest({ sourceRunId: "   ", rows: [{ companyName: "A", phoneNumber: "5551234567" }] });
    const res = await POST(req as never);
    expect(res.status).toBe(422);
    expect(mockStageBatch).not.toHaveBeenCalled();
  });

  it("returns 422 when rows is not an array", async () => {
    const req = makeRequest({ sourceRunId: "run-001", rows: "not-an-array" });
    const res = await POST(req as never);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/rows/);
    expect(mockStageBatch).not.toHaveBeenCalled();
  });

  it("returns 422 for empty rows array", async () => {
    const req = makeRequest({ sourceRunId: "run-001", rows: [] });
    const res = await POST(req as never);
    expect(res.status).toBe(422);
    expect(mockStageBatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/imports/n8n — staging success", () => {
  it("returns 201 with batch counts on first ingest", async () => {
    mockStageBatch.mockResolvedValue(
      makeStageResult({ batchId: "b-001", rowCount: 1, validRowCount: 1, invalidRowCount: 0, duplicate: false })
    );
    const req = makeRequest(VALID_BODY);
    const res = await POST(req as never);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.batchId).toBe("b-001");
    expect(json.duplicate).toBe(false);
    expect(json.rowCount).toBe(1);
    expect(json.validRowCount).toBe(1);
    expect(json.invalidRowCount).toBe(0);
    expect(mockStageBatch).toHaveBeenCalledWith({
      sourceRunId: VALID_BODY.sourceRunId,
      rows: VALID_BODY.rows,
    });
  });

  it("returns 200 with duplicate:true on replay", async () => {
    mockStageBatch.mockResolvedValue(
      makeStageResult({ batchId: "b-001", duplicate: true, rowCount: 2, validRowCount: 1, invalidRowCount: 1 })
    );
    const req = makeRequest({ sourceRunId: "run-abc-001", rows: [{ companyName: "X", phoneNumber: "5551234567" }] });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.duplicate).toBe(true);
    expect(json.rowCount).toBe(2);
  });

  it("returns 201 for a mixed batch and passes correct sourceRunId to stageBatch", async () => {
    mockStageBatch.mockResolvedValue(
      makeStageResult({ batchId: "b-002", rowCount: 3, validRowCount: 2, invalidRowCount: 1, duplicate: false })
    );
    const rows = [
      { companyName: "Acme", phoneNumber: "5551234567" },
      { companyName: "", phoneNumber: "5551234567" }, // validation_error
      { companyName: "Beta", phoneNumber: "5559876543", userEmail: "b@beta.com" },
    ];
    const req = makeRequest({ sourceRunId: "run-mixed-001", rows });
    const res = await POST(req as never);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.validRowCount).toBe(2);
    expect(json.invalidRowCount).toBe(1);
    expect(mockStageBatch).toHaveBeenCalledWith({ sourceRunId: "run-mixed-001", rows });
  });
});

describe("POST /api/imports/n8n — failure paths", () => {
  it("returns 500 when stageBatch throws", async () => {
    mockStageBatch.mockRejectedValue(new Error("DB connection refused"));
    const req = makeRequest(VALID_BODY);
    const res = await POST(req as never);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toMatch(/staging failed/i);
  });

  it("does not expose bearer secret in 401 response body", async () => {
    const req = makeRequest(VALID_BODY, { secret: "secret-that-must-not-leak" });
    vi.stubEnv("N8N_IMPORT_SECRET", "different-correct-secret");
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("secret-that-must-not-leak");
    expect(text).not.toContain("different-correct-secret");
  });
});
