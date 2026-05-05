import { test, expect } from "@playwright/test";

// Read the bearer secret from the environment — the dev server also reads it from its
// environment (via .env.local or an exported shell variable set before playwright runs).
const SECRET = process.env.N8N_IMPORT_SECRET ?? "test-import-secret-local";

const ENDPOINT = "/api/imports/n8n";

function validBody(sourceRunId: string, extraRows?: object[]) {
  return {
    sourceRunId,
    rows: extraRows ?? [
      { companyName: "Acme Corp", phoneNumber: "5551234567", userEmail: "acme@example.com" },
    ],
  };
}

test.describe("n8n import API — authentication", () => {
  test("returns 401 with no Authorization header", async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      data: validBody("e2e-auth-no-header"),
      headers: { "content-type": "application/json" },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 401 with wrong bearer secret", async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      data: validBody("e2e-auth-bad-token"),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer definitely-wrong-secret",
      },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("n8n import API — body validation", () => {
  test("returns 400 for malformed JSON", async ({ request }) => {
    // Use a raw string via `data` so the request body is malformed JSON bytes.
    const res = await request.post(ENDPOINT, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      data: "{{not-valid-json",
    });
    expect(res.status()).toBe(400);
  });

  test("returns 422 when sourceRunId is missing", async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      data: { rows: [{ companyName: "X", phoneNumber: "5551234567" }] },
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });
    expect(res.status()).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/sourceRunId/);
  });

  test("returns 422 when rows is empty", async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      data: { sourceRunId: "e2e-empty-rows", rows: [] },
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });
    expect(res.status()).toBe(422);
  });
});

test.describe("n8n import API — first ingest and replay", () => {
  // Use a timestamp-based sourceRunId to avoid state pollution across test runs.
  const runId = `e2e-first-ingest-${Date.now()}`;

  test("first ingest returns 201 with batch and item counts", async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      data: validBody(runId),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });
    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({
      batchId: expect.any(String),
      duplicate: false,
      rowCount: 1,
      validRowCount: 1,
      invalidRowCount: 0,
    });
    expect(json.batchId).toBeTruthy();
  });

  test("exact replay returns 200 with duplicate:true and unchanged counts", async ({
    request,
  }) => {
    // First call (may already exist from prior test or this run).
    await request.post(ENDPOINT, {
      data: validBody(runId),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    // Replay.
    const res = await request.post(ENDPOINT, {
      data: validBody(runId),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.duplicate).toBe(true);
    expect(json.rowCount).toBe(1);
    expect(json.validRowCount).toBe(1);
    expect(json.invalidRowCount).toBe(0);
  });
});

test.describe("n8n import API — mixed validity batch", () => {
  test("stages valid rows and records validation_error for invalid rows in one batch", async ({
    request,
  }) => {
    const mixedRunId = `e2e-mixed-${Date.now()}`;
    const rows = [
      { companyName: "Good Corp", phoneNumber: "5551234567", userEmail: "good@example.com" },
      { companyName: "", phoneNumber: "5559876543" }, // companyName required → validation_error
      { companyName: "Other Co", phoneNumber: "not-a-phone" }, // unnormalizable phone
    ];
    const res = await request.post(ENDPOINT, {
      data: { sourceRunId: mixedRunId, rows },
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });
    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(json.rowCount).toBe(3);
    expect(json.validRowCount).toBe(1);
    expect(json.invalidRowCount).toBe(2);
    expect(json.duplicate).toBe(false);
  });
});
