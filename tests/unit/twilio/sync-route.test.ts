// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  class MockTwilioSyncError extends Error {
    readonly phase: string;
    readonly requestId: string;
    readonly scope: string;
    readonly details: Record<string, unknown>;

    constructor(message: string, input: { phase: string; requestId: string; scope: string; details?: Record<string, unknown> }) {
      super(message);
      this.name = "TwilioSyncError";
      this.phase = input.phase;
      this.requestId = input.requestId;
      this.scope = input.scope;
      this.details = input.details ?? {};
    }
  }

  return {
    createClient: vi.fn(),
    syncTwilioNumbers: vi.fn(),
    TwilioSyncError: MockTwilioSyncError,
  };
});

vi.mock("@/utils/supabase/server", () => ({
  createClient: hoisted.createClient,
}));

vi.mock("@/features/twilio-sync/sync", () => ({
  syncTwilioNumbers: hoisted.syncTwilioNumbers,
  TwilioSyncError: hoisted.TwilioSyncError,
}));

import { POST } from "@/app/api/internal/twilio/sync/route";
import { createClient } from "@/utils/supabase/server";
import { syncTwilioNumbers, TwilioSyncError } from "@/features/twilio-sync/sync";

const mockCreateClient = vi.mocked(createClient);
const mockSyncTwilioNumbers = vi.mocked(syncTwilioNumbers);

type AuthUser = { id: string; email?: string } | null;
type Profile = { id: string; role: string; is_active: boolean } | null;

type ProfileQueryRecord = {
  table: string;
  selectColumns?: string;
  filters: Array<{ method: string; column: string; value: unknown }>;
};

function makeProfileQuery(record: ProfileQueryRecord, result: { data: Profile; error: { message: string } | null }) {
  return {
    select: vi.fn((columns: string) => {
      record.selectColumns = columns;
      return makeProfileQuery(record, result);
    }),
    eq: vi.fn((column: string, value: unknown) => {
      record.filters.push({ method: "eq", column, value });
      return makeProfileQuery(record, result);
    }),
    maybeSingle: vi.fn(async () => result),
  };
}

function makeSupabaseClient({
  user,
  authError = null,
  profile,
  profileError = null,
}: {
  user: AuthUser;
  authError?: { message: string } | null;
  profile: Profile;
  profileError?: { message: string } | null;
}) {
  const profileCalls: ProfileQueryRecord[] = [];
  const client = {
    profileCalls,
    auth: {
      getUser: vi.fn(async () => ({ data: { user }, error: authError })),
    },
    from: vi.fn((table: string) => {
      const record: ProfileQueryRecord = { table, filters: [] };
      profileCalls.push(record);
      return makeProfileQuery(record, { data: profile, error: profileError });
    }),
  };

  return client;
}

function makeRequest(body?: unknown) {
  return new Request("http://localhost/api/internal/twilio/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function makeRawRequest(body: string) {
  return new Request("http://localhost/api/internal/twilio/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function makeAdminClient() {
  return makeSupabaseClient({
    user: { id: "user-admin-1", email: "admin@example.com" },
    profile: { id: "user-admin-1", role: "admin", is_active: true },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mockSyncTwilioNumbers.mockImplementation(async (input) => ({
    requestId: input.requestId,
    scope: input.scope,
    localCount: 2,
    twilioCount: 2,
    changedCount: 1,
    unchangedCount: 1,
    missingCount: 0,
    upstreamOnlyCount: 0,
    unexpectedRawStatuses: [],
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/internal/twilio/sync — authorization", () => {
  it("returns 401 for missing session before parsing malformed JSON or calling sync", async () => {
    const supabase = makeSupabaseClient({ user: null, profile: null });
    mockCreateClient.mockResolvedValue(supabase as never);

    const res = await POST(makeRawRequest("not-valid-json{{{") as never);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toMatchObject({
      code: "unauthorized",
      message: expect.stringMatching(/sign in/i),
      details: { scope: "full" },
      requestId: expect.any(String),
    });
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(mockSyncTwilioNumbers).not.toHaveBeenCalled();
  });

  it("returns 403 and skips sync for authenticated non-admin profiles", async () => {
    const supabase = makeSupabaseClient({
      user: { id: "user-member-1" },
      profile: { id: "user-member-1", role: "member", is_active: true },
    });
    mockCreateClient.mockResolvedValue(supabase as never);

    const res = await POST(makeRequest() as never);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatchObject({
      code: "forbidden",
      details: { scope: "full" },
      requestId: expect.any(String),
    });
    expect(supabase.from).toHaveBeenCalledWith("users");
    expect(supabase.profileCalls[0]).toMatchObject({
      table: "users",
      selectColumns: expect.stringContaining("role"),
      filters: [{ method: "eq", column: "id", value: "user-member-1" }],
    });
    expect(mockSyncTwilioNumbers).not.toHaveBeenCalled();
  });

  it("returns 403 and skips sync for inactive or missing admin profiles", async () => {
    const inactiveSupabase = makeSupabaseClient({
      user: { id: "user-inactive-1" },
      profile: { id: "user-inactive-1", role: "admin", is_active: false },
    });
    mockCreateClient.mockResolvedValueOnce(inactiveSupabase as never);

    const inactiveRes = await POST(makeRequest() as never);
    expect(inactiveRes.status).toBe(403);

    const missingProfileSupabase = makeSupabaseClient({ user: { id: "user-missing-1" }, profile: null });
    mockCreateClient.mockResolvedValueOnce(missingProfileSupabase as never);

    const missingRes = await POST(makeRequest() as never);
    expect(missingRes.status).toBe(403);
    expect(mockSyncTwilioNumbers).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/twilio/sync — body validation", () => {
  it("returns 400 for malformed JSON after authorization", async () => {
    mockCreateClient.mockResolvedValue(makeAdminClient() as never);

    const res = await POST(makeRawRequest("not-valid-json{{{") as never);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatchObject({
      code: "invalid_json",
      details: { scope: "full" },
      requestId: expect.any(String),
    });
    expect(mockSyncTwilioNumbers).not.toHaveBeenCalled();
  });

  it("returns 422 when phoneNumbers is not an array", async () => {
    mockCreateClient.mockResolvedValue(makeAdminClient() as never);

    const res = await POST(makeRequest({ phoneNumbers: "+15551234567" }) as never);

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatchObject({
      code: "invalid_phone_numbers",
      details: { scope: "targeted" },
      requestId: expect.any(String),
    });
    expect(mockSyncTwilioNumbers).not.toHaveBeenCalled();
  });

  it("returns 422 when targeted sync contains too many phone numbers", async () => {
    mockCreateClient.mockResolvedValue(makeAdminClient() as never);

    const res = await POST(
      makeRequest({ phoneNumbers: Array.from({ length: 201 }, (_, index) => `+1555000${String(index).padStart(4, "0")}`) }) as never
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatchObject({
      code: "too_many_phone_numbers",
      details: { scope: "targeted", maxPhoneNumbers: 200 },
      requestId: expect.any(String),
    });
    expect(mockSyncTwilioNumbers).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/twilio/sync — sync delegation", () => {
  it("returns a canonical success envelope for full-account sync", async () => {
    mockCreateClient.mockResolvedValue(makeAdminClient() as never);

    const res = await POST(makeRequest() as never);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      data: {
        requestId: expect.any(String),
        scope: "full",
        localCount: 2,
        twilioCount: 2,
        changedCount: 1,
        unchangedCount: 1,
        missingCount: 0,
        upstreamOnlyCount: 0,
        unexpectedRawStatuses: [],
      },
    });
    expect(mockSyncTwilioNumbers).toHaveBeenCalledWith({
      scope: "full",
      actorUserId: "user-admin-1",
      requestId: json.data.requestId,
    });
  });

  it("normalizes and delegates targeted phone-number sync", async () => {
    mockCreateClient.mockResolvedValue(makeAdminClient() as never);
    mockSyncTwilioNumbers.mockImplementationOnce(async (input) => ({
      requestId: input.requestId,
      scope: input.scope,
      localCount: 1,
      twilioCount: 1,
      changedCount: 0,
      unchangedCount: 1,
      missingCount: 0,
      upstreamOnlyCount: 0,
      unexpectedRawStatuses: [],
    }));

    const res = await POST(makeRequest({ phoneNumbers: ["(555) 123-4567", "+15557654321"] }) as never);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ scope: "targeted", requestId: expect.any(String) });
    expect(mockSyncTwilioNumbers).toHaveBeenCalledWith({
      scope: "targeted",
      phoneNumbers: ["+15551234567", "+15557654321"],
      actorUserId: "user-admin-1",
      requestId: json.data.requestId,
    });
  });

  it("returns 502 with canonical redacted details for Twilio upstream failures", async () => {
    mockCreateClient.mockResolvedValue(makeAdminClient() as never);
    mockSyncTwilioNumbers.mockImplementationOnce(async (input) => {
      throw new TwilioSyncError("Twilio auth token sk_secret_token failed", {
        phase: "twilio_list",
        requestId: input.requestId,
        scope: input.scope,
        details: { phase: "twilio_list", message: "upstream unavailable" },
      });
    });

    const res = await POST(makeRequest({ phoneNumbers: ["+15551234567"] }) as never);

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("sk_secret_token");
    expect(text).not.toContain("Error:");
    const json = JSON.parse(text);
    expect(json.error).toMatchObject({
      code: "twilio_sync_failed",
      message: expect.stringMatching(/Twilio sync failed/i),
      details: { scope: "targeted", phase: "twilio_list" },
      requestId: expect.any(String),
    });
  });

  it("returns 500 without stack traces or secrets for unexpected server errors", async () => {
    mockCreateClient.mockResolvedValue(makeAdminClient() as never);
    mockSyncTwilioNumbers.mockRejectedValueOnce(new Error("SUPABASE_SERVICE_ROLE_KEY=service-role-secret exploded"));

    const res = await POST(makeRequest() as never);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("service-role-secret");
    expect(text).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(text).not.toContain("Error:");
    const json = JSON.parse(text);
    expect(json.error).toMatchObject({
      code: "internal_error",
      details: { scope: "full" },
      requestId: expect.any(String),
    });
  });
});
