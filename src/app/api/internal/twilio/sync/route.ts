import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { syncTwilioNumbers, TwilioSyncError, type SyncTwilioNumbersResult } from "@/features/twilio-sync/sync";
import { createClient } from "@/utils/supabase/server";
import { MAX_TARGETED_PHONE_NUMBERS, normalizeTargetedPhoneNumbers } from "@/utils/twilio/status";

export const runtime = "nodejs";

const ROUTE_LOG_PREFIX = "[twilio-sync]";

type SyncScope = "full" | "targeted";
type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_json"
  | "invalid_body"
  | "invalid_phone_numbers"
  | "too_many_phone_numbers"
  | "twilio_sync_failed"
  | "internal_error";

type UserProfile = {
  id: string;
  role: string;
  is_active: boolean;
};

type ParsedRequestBody =
  | { ok: true; scope: "full" }
  | { ok: true; scope: "targeted"; phoneNumbers: string[] }
  | { ok: false; status: 400 | 422; code: ErrorCode; message: string; scope: SyncScope; details?: Record<string, unknown> };

function logTwilioRoute(event: string, fields: Record<string, unknown>) {
  console.log(`${ROUTE_LOG_PREFIX} ${JSON.stringify({ event, ...fields })}`);
}

function logTwilioRouteError(event: string, fields: Record<string, unknown>) {
  console.error(`${ROUTE_LOG_PREFIX} ${JSON.stringify({ event, ...fields })}`);
}

function jsonError(
  status: number,
  input: {
    code: ErrorCode;
    message: string;
    requestId: string;
    scope: SyncScope;
    details?: Record<string, unknown>;
  }
) {
  return Response.json(
    {
      error: {
        code: input.code,
        message: input.message,
        details: { scope: input.scope, ...(input.details ?? {}) },
        requestId: input.requestId,
      },
    },
    { status }
  );
}

function successEnvelope(result: SyncTwilioNumbersResult) {
  return Response.json({ data: result }, { status: 200 });
}

function getSafeErrorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error;
}

async function parseRequestBody(request: NextRequest | Request): Promise<ParsedRequestBody> {
  let rawBody: string;

  try {
    rawBody = await request.text();
  } catch {
    return {
      ok: false,
      status: 400,
      code: "invalid_json",
      message: "Request body must be valid JSON when provided.",
      scope: "full",
    };
  }

  if (!rawBody.trim()) {
    return { ok: true, scope: "full" };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "invalid_json",
      message: "Request body must be valid JSON when provided.",
      scope: "full",
    };
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_body",
      message: "Request body must be a JSON object when provided.",
      scope: "full",
    };
  }

  if (!Object.hasOwn(body, "phoneNumbers")) {
    return { ok: true, scope: "full" };
  }

  const rawPhoneNumbers = (body as { phoneNumbers?: unknown }).phoneNumbers;
  const scope: SyncScope = "targeted";

  if (!Array.isArray(rawPhoneNumbers)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_phone_numbers",
      message: "phoneNumbers must be an array of phone numbers.",
      scope,
    };
  }

  if (rawPhoneNumbers.length > MAX_TARGETED_PHONE_NUMBERS) {
    return {
      ok: false,
      status: 422,
      code: "too_many_phone_numbers",
      message: `Targeted sync accepts at most ${MAX_TARGETED_PHONE_NUMBERS} phone numbers per request.`,
      scope,
      details: { maxPhoneNumbers: MAX_TARGETED_PHONE_NUMBERS },
    };
  }

  const normalized = normalizeTargetedPhoneNumbers(rawPhoneNumbers, MAX_TARGETED_PHONE_NUMBERS);

  if (normalized.errors.length > 0 || normalized.numbers.length === 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_phone_numbers",
      message: "phoneNumbers must contain at least one valid phone number normalized to E.164.",
      scope,
      details: { errors: normalized.errors.slice(0, 20) },
    };
  }

  return { ok: true, scope, phoneNumbers: normalized.numbers };
}

async function getActiveAdminProfile(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data, error } = await supabase
    .from("users")
    .select("id, role, is_active")
    .eq("id", userId)
    .maybeSingle<UserProfile>();

  if (error) {
    throw error;
  }

  if (!data || data.role !== "admin" || !data.is_active) {
    return null;
  }

  return data;
}

export async function POST(request: NextRequest) {
  const requestId = `req_${randomUUID()}`;
  let scope: SyncScope = "full";

  try {
    const supabase = await createClient();
    const { data: authData, error: authError } = await supabase.auth.getUser();
    const user = authData.user;

    if (authError || !user) {
      logTwilioRoute("auth-rejected", {
        requestId,
        scope,
        reason: authError ? "auth_error" : "missing_session",
      });
      return jsonError(401, {
        code: "unauthorized",
        message: "You must sign in before running Twilio sync.",
        requestId,
        scope,
      });
    }

    let profile: UserProfile | null;
    try {
      profile = await getActiveAdminProfile(supabase, user.id);
    } catch (error) {
      logTwilioRouteError("profile-lookup-failed", {
        requestId,
        scope,
        userId: user.id,
        errorType: getSafeErrorName(error),
      });
      return jsonError(500, {
        code: "internal_error",
        message: "Twilio sync could not verify the active admin profile.",
        requestId,
        scope,
      });
    }

    if (!profile) {
      logTwilioRoute("authorization-rejected", {
        requestId,
        scope,
        userId: user.id,
        reason: "inactive_or_non_admin_profile",
      });
      return jsonError(403, {
        code: "forbidden",
        message: "Only active admin users can run Twilio sync.",
        requestId,
        scope,
      });
    }

    const parsedBody = await parseRequestBody(request);
    scope = parsedBody.scope;

    if (!parsedBody.ok) {
      logTwilioRoute("validation-rejected", {
        requestId,
        scope,
        code: parsedBody.code,
        status: parsedBody.status,
      });
      return jsonError(parsedBody.status, {
        code: parsedBody.code,
        message: parsedBody.message,
        requestId,
        scope,
        details: parsedBody.details,
      });
    }

    logTwilioRoute("sync-request-authorized", {
      requestId,
      scope,
      actorUserId: user.id,
      targetedCount: parsedBody.scope === "targeted" ? parsedBody.phoneNumbers.length : 0,
    });

    const result = await syncTwilioNumbers({
      scope: parsedBody.scope,
      ...(parsedBody.scope === "targeted" ? { phoneNumbers: parsedBody.phoneNumbers } : {}),
      actorUserId: user.id,
      requestId,
    });

    logTwilioRoute("sync-response", {
      requestId,
      scope: result.scope,
      localCount: result.localCount,
      twilioCount: result.twilioCount,
      changedCount: result.changedCount,
      unchangedCount: result.unchangedCount,
      missingCount: result.missingCount,
      upstreamOnlyCount: result.upstreamOnlyCount,
      unexpectedRawStatusCount: result.unexpectedRawStatuses.length,
    });

    return successEnvelope(result);
  } catch (error) {
    if (error instanceof TwilioSyncError) {
      logTwilioRouteError("upstream-failure", {
        requestId,
        scope: error.scope,
        phase: error.phase,
      });
      return jsonError(502, {
        code: "twilio_sync_failed",
        message: "Twilio sync failed while contacting or reconciling upstream data.",
        requestId,
        scope: error.scope,
        details: { phase: error.phase },
      });
    }

    logTwilioRouteError("unexpected-failure", {
      requestId,
      scope,
      errorType: getSafeErrorName(error),
    });
    return jsonError(500, {
      code: "internal_error",
      message: "Twilio sync failed unexpectedly.",
      requestId,
      scope,
    });
  }
}
