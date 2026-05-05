// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// Mock the admin client to prevent env checks during import.
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { commitBatch } from "@/features/imports/commit-batch";
import { createAdminClient } from "@/utils/supabase/admin";

const mockCreateAdminClient = vi.mocked(createAdminClient);

// ---------------------------------------------------------------------------
// Supabase chain builder
// Supabase FilterBuilders are PromiseLike — `await builder` resolves directly
// without needing .single() or .maybeSingle(). The chain mock must support both:
//   await supabase.from("t").select("*").eq("x", v)          ← direct await
//   await supabase.from("t").select("id").eq("x", v).single() ← terminal method
// ---------------------------------------------------------------------------
function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};

  // Make the chain itself thenable so `await chain` resolves to result
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);

  const methods = [
    "select", "insert", "update", "upsert", "eq", "is", "ilike",
    "limit", "filter",
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => makeChain(result));
  }

  // Terminal methods that also return promises
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.single = vi.fn(() => Promise.resolve(result));

  return chain;
}

// Build a mock client. fromMap: table → array of sequential results per call.
function buildClient(fromMap: Record<string, { data: unknown; error: unknown }[]>) {
  const callCounts: Record<string, number> = {};

  const client = {
    from: vi.fn((table: string) => {
      callCounts[table] = (callCounts[table] ?? 0) + 1;
      const results = fromMap[table] ?? [];
      const idx = callCounts[table] - 1;
      const result = results[idx] ?? { data: null, error: null };
      return makeChain(result);
    }),
  };

  return client as unknown as ReturnType<typeof createAdminClient>;
}

const BATCH_ID = "batch-uuid-001";
const ACTOR_ID = "actor-uuid-001";

const VALID_ITEMS = [
  {
    id: "item-uuid-001",
    batch_id: BATCH_ID,
    company_name: "Acme Corp",
    user_email: "billing@acme.com",
    phone_number: "+15551234567",
    status: "valid",
  },
  {
    id: "item-uuid-002",
    batch_id: BATCH_ID,
    company_name: "Beta Ltd",
    user_email: null,
    phone_number: "+15559876543",
    status: "valid",
  },
];

// ---------------------------------------------------------------------------
// Test: already-committed guard
// ---------------------------------------------------------------------------
describe("commitBatch — already committed guard", () => {
  it("returns { committed: 0, skipped: 0 } and makes no further writes when batch is already committed", async () => {
    const client = buildClient({
      import_batches: [{ data: { status: "committed" }, error: null }],
    });
    mockCreateAdminClient.mockReturnValue(client);

    const result = await commitBatch({ batchId: BATCH_ID, actorUserId: ACTOR_ID });

    expect(result).toEqual({ committed: 0, skipped: 0 });
    // Only the initial status lookup — no items fetch
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(client.from).toHaveBeenCalledWith("import_batches");
  });
});

// ---------------------------------------------------------------------------
// Test: happy path — 2 valid items, all new
// ---------------------------------------------------------------------------
describe("commitBatch — happy path (2 new items)", () => {
  it("inserts 2 companies, 2 numbers, 2 assignments, updates items+batch, writes audit log, returns { committed: 2, skipped: 0 }", async () => {
    const client = buildClient({
      import_batches: [
        { data: { status: "staged" }, error: null },   // status lookup
        { data: null, error: null },                    // UPDATE batch status
      ],
      import_items: [
        { data: VALID_ITEMS, error: null },             // SELECT valid items
        { data: null, error: null },                    // UPDATE items to committed
      ],
      companies: [
        { data: null, error: null },                    // SELECT company 1 (not found)
        { data: { id: "company-uuid-001" }, error: null }, // INSERT company 1
        { data: null, error: null },                    // SELECT company 2 (not found)
        { data: { id: "company-uuid-002" }, error: null }, // INSERT company 2
      ],
      numbers: [
        { data: { id: "number-uuid-001" }, error: null }, // UPSERT number 1
        { data: { id: "number-uuid-002" }, error: null }, // UPSERT number 2
      ],
      assignment_history: [
        { data: null, error: null },   // SELECT open assignment 1 (not found)
        { data: null, error: null },   // INSERT assignment 1
        { data: null, error: null },   // SELECT open assignment 2 (not found)
        { data: null, error: null },   // INSERT assignment 2
      ],
      audit_logs: [{ data: null, error: null }],
    });
    mockCreateAdminClient.mockReturnValue(client);

    const result = await commitBatch({ batchId: BATCH_ID, actorUserId: ACTOR_ID });

    expect(result).toEqual({ committed: 2, skipped: 0 });
    expect(client.from).toHaveBeenCalledWith("import_batches");
    expect(client.from).toHaveBeenCalledWith("import_items");
    expect(client.from).toHaveBeenCalledWith("companies");
    expect(client.from).toHaveBeenCalledWith("numbers");
    expect(client.from).toHaveBeenCalledWith("assignment_history");
    expect(client.from).toHaveBeenCalledWith("audit_logs");
  });
});

// ---------------------------------------------------------------------------
// Test: company already exists → reuse existing id, no INSERT
// ---------------------------------------------------------------------------
describe("commitBatch — company already exists", () => {
  it("uses the existing company_id without inserting a new company row", async () => {
    const singleItem = [VALID_ITEMS[0]];
    const client = buildClient({
      import_batches: [
        { data: { status: "staged" }, error: null },
        { data: null, error: null },
      ],
      import_items: [
        { data: singleItem, error: null },
        { data: null, error: null },
      ],
      companies: [
        // SELECT returns existing row — no INSERT should follow
        { data: { id: "existing-company-uuid" }, error: null },
      ],
      numbers: [
        { data: { id: "number-uuid-001" }, error: null },
      ],
      assignment_history: [
        { data: null, error: null },   // open guard: not found
        { data: null, error: null },   // INSERT
      ],
      audit_logs: [{ data: null, error: null }],
    });
    mockCreateAdminClient.mockReturnValue(client);

    const result = await commitBatch({ batchId: BATCH_ID, actorUserId: ACTOR_ID });

    expect(result).toEqual({ committed: 1, skipped: 0 });

    // companies.from should have been called exactly once (SELECT only, no INSERT)
    const companyCalls = (client.from as ReturnType<typeof vi.fn>).mock.calls.filter(([t]) => t === "companies");
    expect(companyCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test: open assignment exists → skip that number
// ---------------------------------------------------------------------------
describe("commitBatch — open assignment guard", () => {
  it("skips INSERT for number with existing open assignment and increments skipped counter", async () => {
    const singleItem = [VALID_ITEMS[0]];
    const client = buildClient({
      import_batches: [
        { data: { status: "staged" }, error: null },
        { data: null, error: null },
      ],
      import_items: [
        { data: singleItem, error: null },
        { data: null, error: null },
      ],
      companies: [
        { data: { id: "existing-company-uuid" }, error: null },
      ],
      numbers: [
        { data: { id: "number-uuid-001" }, error: null },
      ],
      assignment_history: [
        // Open assignment SELECT returns an existing row → skip
        { data: { id: "existing-assignment-uuid" }, error: null },
      ],
      audit_logs: [{ data: null, error: null }],
    });
    mockCreateAdminClient.mockReturnValue(client);

    const result = await commitBatch({ batchId: BATCH_ID, actorUserId: ACTOR_ID });

    expect(result).toEqual({ committed: 0, skipped: 1 });

    // assignment_history should be called exactly once (SELECT only, no INSERT)
    const ahCalls = (client.from as ReturnType<typeof vi.fn>).mock.calls.filter(([t]) => t === "assignment_history");
    expect(ahCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test: user_email null → no billing_email in company INSERT
// ---------------------------------------------------------------------------
describe("commitBatch — null user_email", () => {
  it("does not include billing_email in company INSERT payload when user_email is null", async () => {
    const itemWithNullEmail = [{ ...VALID_ITEMS[0], user_email: null }];

    let capturedInsertPayload: unknown = null;

    // Custom client so we can inspect the insert payload
    let importBatchesCallCount = 0;
    let importItemsCallCount = 0;
    let companiesCallCount = 0;

    const client = {
      from: vi.fn((table: string) => {
        if (table === "import_batches") {
          importBatchesCallCount++;
          const result = importBatchesCallCount === 1
            ? { data: { status: "staged" }, error: null }
            : { data: null, error: null };
          return makeChain(result);
        }
        if (table === "import_items") {
          importItemsCallCount++;
          const result = importItemsCallCount === 1
            ? { data: itemWithNullEmail, error: null }
            : { data: null, error: null };
          return makeChain(result);
        }
        if (table === "companies") {
          companiesCallCount++;
          if (companiesCallCount === 1) {
            // SELECT — not found
            return makeChain({ data: null, error: null });
          }
          // INSERT — capture payload
          const chain = makeChain({ data: { id: "new-company-uuid" }, error: null });
          chain.insert = vi.fn((payload: unknown) => {
            capturedInsertPayload = payload;
            return makeChain({ data: { id: "new-company-uuid" }, error: null });
          });
          return chain;
        }
        if (table === "numbers") {
          return makeChain({ data: { id: "number-uuid-001" }, error: null });
        }
        if (table === "assignment_history") {
          return makeChain({ data: null, error: null });
        }
        if (table === "audit_logs") {
          return makeChain({ data: null, error: null });
        }
        return makeChain({ data: null, error: null });
      }),
    };

    mockCreateAdminClient.mockReturnValue(client as unknown as ReturnType<typeof createAdminClient>);

    await commitBatch({ batchId: BATCH_ID, actorUserId: ACTOR_ID });

    // billing_email must not appear in the INSERT payload when user_email is null
    expect(capturedInsertPayload).not.toBeNull();
    expect(capturedInsertPayload).not.toHaveProperty("billing_email");
  });
});

// ---------------------------------------------------------------------------
// Test: audit log is always written (even when all items skipped)
// ---------------------------------------------------------------------------
describe("commitBatch — audit log always written", () => {
  it("writes audit log even when all assignments are skipped", async () => {
    const singleItem = [VALID_ITEMS[0]];
    const client = buildClient({
      import_batches: [
        { data: { status: "staged" }, error: null },
        { data: null, error: null },
      ],
      import_items: [
        { data: singleItem, error: null },
        { data: null, error: null },
      ],
      companies: [
        { data: { id: "company-uuid-001" }, error: null },
      ],
      numbers: [
        { data: { id: "number-uuid-001" }, error: null },
      ],
      assignment_history: [
        // Open assignment exists → skipped
        { data: { id: "existing-open-uuid" }, error: null },
      ],
      audit_logs: [{ data: null, error: null }],
    });
    mockCreateAdminClient.mockReturnValue(client);

    const result = await commitBatch({ batchId: BATCH_ID, actorUserId: ACTOR_ID });

    expect(result).toEqual({ committed: 0, skipped: 1 });

    const auditCalls = (client.from as ReturnType<typeof vi.fn>).mock.calls.filter(([t]) => t === "audit_logs");
    expect(auditCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test: no valid items — batch+items updated and audit log still written
// ---------------------------------------------------------------------------
describe("commitBatch — no valid items", () => {
  it("updates batch status and writes audit log even when there are no valid items", async () => {
    const client = buildClient({
      import_batches: [
        { data: { status: "staged" }, error: null },
        { data: null, error: null },
      ],
      import_items: [
        { data: [], error: null },    // empty valid items
        { data: null, error: null },
      ],
      audit_logs: [{ data: null, error: null }],
    });
    mockCreateAdminClient.mockReturnValue(client);

    const result = await commitBatch({ batchId: BATCH_ID, actorUserId: ACTOR_ID });

    expect(result).toEqual({ committed: 0, skipped: 0 });

    const auditCalls = (client.from as ReturnType<typeof vi.fn>).mock.calls.filter(([t]) => t === "audit_logs");
    expect(auditCalls).toHaveLength(1);
  });
});
