// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/twilio/client", () => ({
  createTwilioClient: vi.fn(),
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { syncTwilioNumbers, TwilioSyncError } from "@/features/twilio-sync/sync";
import { createTwilioClient } from "@/utils/twilio/client";
import { createAdminClient } from "@/utils/supabase/admin";

const mockCreateTwilioClient = vi.mocked(createTwilioClient);
const mockCreateAdminClient = vi.mocked(createAdminClient);

type QueryRecord = {
  table: string;
  operation: string | null;
  selectColumns?: string;
  insertPayload?: unknown;
  updatePayload?: unknown;
  filters: Array<{ method: string; column: string; value: unknown }>;
};

type SupabaseResult = { data: unknown; error: { message: string } | null };

function makeThenableQuery(record: QueryRecord, result: SupabaseResult) {
  const query: Record<string, unknown> = {
    select: vi.fn((columns?: string) => {
      record.operation = record.operation ?? "select";
      record.selectColumns = columns;
      return query;
    }),
    update: vi.fn((payload: unknown) => {
      record.operation = "update";
      record.updatePayload = payload;
      return query;
    }),
    insert: vi.fn((payload: unknown) => {
      record.operation = "insert";
      record.insertPayload = payload;
      return query;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      record.filters.push({ method: "eq", column, value });
      return query;
    }),
    in: vi.fn((column: string, value: unknown) => {
      record.filters.push({ method: "in", column, value });
      return query;
    }),
    then: (resolve: (value: SupabaseResult) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };

  return query;
}

function makeSupabaseClient(results: Record<string, SupabaseResult[]>) {
  const calls: QueryRecord[] = [];
  const tableCallCounts: Record<string, number> = {};

  const client = {
    calls,
    from: vi.fn((table: string) => {
      tableCallCounts[table] = (tableCallCounts[table] ?? 0) + 1;
      const result = results[table]?.[tableCallCounts[table] - 1] ?? { data: null, error: null };
      const record: QueryRecord = { table, operation: null, filters: [] };
      calls.push(record);
      return makeThenableQuery(record, result);
    }),
  };

  return client;
}

const LOCAL_ROWS = [
  {
    id: "number-1",
    phone_number: "+15551234567",
    twilio_status: "unknown",
    assignment_status: "assigned",
    billing_status: "excluded",
  },
  {
    id: "number-2",
    phone_number: "+15557654321",
    twilio_status: "active",
    assignment_status: "unassigned",
    billing_status: "billable",
  },
];

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe("syncTwilioNumbers", () => {
  it("updates only changed twilio_status values and writes twilio audit rows", async () => {
    mockCreateTwilioClient.mockReturnValue({
      incomingPhoneNumbers: {
        list: vi.fn().mockResolvedValue([
          { phoneNumber: "+15551234567", status: "in-use" },
          { phoneNumber: "+15550000000", status: "in-use" },
        ]),
      },
    } as never);

    const supabase = makeSupabaseClient({
      numbers: [
        { data: LOCAL_ROWS, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
      audit_logs: [{ data: null, error: null }, { data: null, error: null }],
    });
    mockCreateAdminClient.mockReturnValue(supabase as never);

    const result = await syncTwilioNumbers({
      scope: "full",
      actorUserId: "actor-1",
      requestId: "req-1",
    });

    expect(result).toMatchObject({
      requestId: "req-1",
      scope: "full",
      localCount: 2,
      twilioCount: 2,
      changedCount: 2,
      unchangedCount: 0,
      missingCount: 1,
      upstreamOnlyCount: 1,
    });

    const updateCalls = supabase.calls.filter((call) => call.table === "numbers" && call.operation === "update");
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls.map((call) => call.updatePayload)).toEqual([
      { twilio_status: "active" },
      { twilio_status: "missing" },
    ]);
    expect(updateCalls[0].updatePayload).not.toHaveProperty("assignment_status");
    expect(updateCalls[0].updatePayload).not.toHaveProperty("billing_status");

    const auditCalls = supabase.calls.filter((call) => call.table === "audit_logs" && call.operation === "insert");
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls[0].insertPayload).toMatchObject({
      entity_type: "number",
      entity_id: "number-1",
      action: "twilio_status_sync",
      source: "twilio",
      actor_user_id: "actor-1",
      old_values: { twilio_status: "unknown" },
      new_values: { twilio_status: "active", requestId: "req-1", rawTwilioStatus: "in-use" },
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("[twilio-sync]"));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"diff-complete"'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('"changedStatuses":{"unknown->active":1,"active->missing":1}'));
  });

  it("filters local rows for targeted sync subsets", async () => {
    mockCreateTwilioClient.mockReturnValue({
      incomingPhoneNumbers: {
        list: vi.fn().mockResolvedValue([{ phoneNumber: "+15551234567", status: "in-use" }]),
      },
    } as never);

    const supabase = makeSupabaseClient({
      numbers: [{ data: [LOCAL_ROWS[0]], error: null }, { data: null, error: null }],
      audit_logs: [{ data: null, error: null }],
    });
    mockCreateAdminClient.mockReturnValue(supabase as never);

    await syncTwilioNumbers({
      scope: "targeted",
      phoneNumbers: ["+15551234567"],
      actorUserId: "actor-1",
      requestId: "req-targeted",
    });

    const localSelect = supabase.calls.find((call) => call.table === "numbers" && call.operation === "select");
    expect(localSelect?.filters).toContainEqual({
      method: "in",
      column: "phone_number",
      value: ["+15551234567"],
    });
  });

  it("returns zero counts and performs no writes for empty local inventory", async () => {
    mockCreateTwilioClient.mockReturnValue({
      incomingPhoneNumbers: {
        list: vi.fn().mockResolvedValue([{ phoneNumber: "+15551234567", status: "in-use" }]),
      },
    } as never);
    const supabase = makeSupabaseClient({ numbers: [{ data: [], error: null }] });
    mockCreateAdminClient.mockReturnValue(supabase as never);

    const result = await syncTwilioNumbers({ scope: "full", actorUserId: "actor-1", requestId: "req-empty" });

    expect(result.changedCount).toBe(0);
    expect(result.localCount).toBe(0);
    expect(supabase.calls.filter((call) => call.operation === "update" || call.operation === "insert")).toHaveLength(0);
  });

  it("maps unexpected raw Twilio status to inactive and reports diagnostics", async () => {
    mockCreateTwilioClient.mockReturnValue({
      incomingPhoneNumbers: {
        list: vi.fn().mockResolvedValue([{ phoneNumber: "+15551234567", status: "suspended" }]),
      },
    } as never);
    const supabase = makeSupabaseClient({
      numbers: [{ data: [{ ...LOCAL_ROWS[0], twilio_status: "active" }], error: null }, { data: null, error: null }],
      audit_logs: [{ data: null, error: null }],
    });
    mockCreateAdminClient.mockReturnValue(supabase as never);

    const result = await syncTwilioNumbers({ scope: "full", actorUserId: "actor-1", requestId: "req-raw" });

    expect(result.unexpectedRawStatuses).toEqual([{ phoneNumber: "+15551234567", rawStatus: "suspended" }]);
    const update = supabase.calls.find((call) => call.table === "numbers" && call.operation === "update");
    expect(update?.updatePayload).toEqual({ twilio_status: "inactive" });
  });

  it("does not update numbers when Twilio inventory listing fails", async () => {
    mockCreateTwilioClient.mockReturnValue({
      incomingPhoneNumbers: {
        list: vi.fn().mockRejectedValue(new Error("Twilio rejected request")),
      },
    } as never);
    const supabase = makeSupabaseClient({ numbers: [{ data: LOCAL_ROWS, error: null }] });
    mockCreateAdminClient.mockReturnValue(supabase as never);

    await expect(
      syncTwilioNumbers({ scope: "full", actorUserId: "actor-1", requestId: "req-fail" })
    ).rejects.toMatchObject({ phase: "twilio_list", requestId: "req-fail" });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('"phase":"twilio_list"'));
  });

  it("throws request and scope context for Supabase update failures without mutating assignment or billing fields", async () => {
    mockCreateTwilioClient.mockReturnValue({
      incomingPhoneNumbers: {
        list: vi.fn().mockResolvedValue([{ phoneNumber: "+15551234567", status: "in-use" }]),
      },
    } as never);
    const supabase = makeSupabaseClient({
      numbers: [
        { data: [LOCAL_ROWS[0]], error: null },
        { data: null, error: { message: "update denied" } },
      ],
    });
    mockCreateAdminClient.mockReturnValue(supabase as never);

    await expect(
      syncTwilioNumbers({ scope: "full", actorUserId: "actor-1", requestId: "req-db" })
    ).rejects.toBeInstanceOf(TwilioSyncError);

    const update = supabase.calls.find((call) => call.table === "numbers" && call.operation === "update");
    expect(update?.updatePayload).toEqual({ twilio_status: "active" });
  });
});
