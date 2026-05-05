import { createAdminClient } from "@/utils/supabase/admin";
import { createTwilioClient } from "@/utils/twilio/client";
import {
  normalizeTwilioPhoneNumber,
  toLocalTwilioStatus,
  type DatabaseTwilioStatus,
} from "@/utils/twilio/status";

type SyncScope = "full" | "targeted";
type FailurePhase =
  | "twilio_config"
  | "twilio_list"
  | "local_select"
  | "number_update"
  | "audit_insert";

type SupabaseErrorLike = { message?: string; code?: string };

type SupabaseQueryResult<T> = {
  data: T | null;
  error: SupabaseErrorLike | null;
};

type SupabaseQuery<T> = PromiseLike<SupabaseQueryResult<T>>;

type NumbersSelectQuery = SupabaseQuery<LocalNumberRow[]> & {
  in(column: string, values: string[]): NumbersSelectQuery;
};

type SupabaseClientLike = {
  from(table: "numbers"): {
    select(columns: string): NumbersSelectQuery;
    update(payload: { twilio_status: DatabaseTwilioStatus }): {
      eq(column: string, value: string): SupabaseQuery<null>;
    };
  };
  from(table: "audit_logs"): {
    insert(payload: AuditLogInsert): SupabaseQuery<null>;
  };
};

type TwilioIncomingPhoneNumber = {
  phoneNumber?: unknown;
  status?: unknown;
};

type TwilioClientLike = {
  incomingPhoneNumbers: {
    list(options?: { pageSize?: number; limit?: number }): Promise<TwilioIncomingPhoneNumber[]>;
  };
};

interface LocalNumberRow {
  id: string;
  phone_number: string;
  twilio_status: DatabaseTwilioStatus;
  assignment_status?: string;
  billing_status?: string;
}

interface AuditLogInsert {
  entity_type: "number";
  entity_id: string;
  action: "twilio_status_sync";
  actor_user_id: string;
  source: "twilio";
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
}

interface TwilioInventoryEntry {
  phoneNumber: string;
  status: Exclude<DatabaseTwilioStatus, "unknown" | "missing" | "released">;
  rawStatus: string | null;
  isUnexpectedRawStatus: boolean;
}

interface StatusChange {
  row: LocalNumberRow;
  nextStatus: DatabaseTwilioStatus;
  rawTwilioStatus: string | null;
  reason: "twilio-returned" | "twilio-missing";
}

export interface SyncTwilioNumbersInput {
  scope: SyncScope;
  phoneNumbers?: string[];
  actorUserId: string;
  requestId: string;
}

export interface SyncTwilioNumbersResult {
  requestId: string;
  scope: SyncScope;
  localCount: number;
  twilioCount: number;
  changedCount: number;
  unchangedCount: number;
  missingCount: number;
  upstreamOnlyCount: number;
  unexpectedRawStatuses: Array<{ phoneNumber: string; rawStatus: string | null }>;
}

export class TwilioSyncError extends Error {
  readonly phase: FailurePhase;
  readonly requestId: string;
  readonly scope: SyncScope;
  readonly details: Record<string, unknown>;

  constructor(message: string, input: { phase: FailurePhase; requestId: string; scope: SyncScope; details?: Record<string, unknown>; cause?: unknown }) {
    super(message, { cause: input.cause });
    this.name = "TwilioSyncError";
    this.phase = input.phase;
    this.requestId = input.requestId;
    this.scope = input.scope;
    this.details = input.details ?? {};
  }
}

function logTwilioSync(event: string, fields: Record<string, unknown>) {
  console.log(`[twilio-sync] ${JSON.stringify({ event, ...fields })}`);
}

function logTwilioSyncError(event: string, fields: Record<string, unknown>) {
  console.error(`[twilio-sync] ${JSON.stringify({ event, ...fields })}`);
}

function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    const maybeError = error as { message?: unknown; code?: unknown; status?: unknown };
    return {
      message: typeof maybeError.message === "string" ? maybeError.message : "unknown error",
      code: typeof maybeError.code === "string" ? maybeError.code : undefined,
      status: typeof maybeError.status === "number" ? maybeError.status : undefined,
    };
  }

  return { message: typeof error === "string" ? error : "unknown error" };
}

function toTwilioSyncError(
  error: unknown,
  input: { phase: FailurePhase; requestId: string; scope: SyncScope; details?: Record<string, unknown> }
) {
  if (error instanceof TwilioSyncError) {
    return error;
  }

  const safeDetails = { ...safeErrorDetails(error), ...input.details };
  return new TwilioSyncError(`[twilio-sync] ${input.phase} failed`, {
    phase: input.phase,
    requestId: input.requestId,
    scope: input.scope,
    details: safeDetails,
    cause: error,
  });
}

function buildTwilioInventoryMap(records: TwilioIncomingPhoneNumber[]) {
  const inventory = new Map<string, TwilioInventoryEntry>();
  const invalidPhoneNumberCount = { value: 0 };

  for (const record of records) {
    const { e164 } = normalizeTwilioPhoneNumber(record.phoneNumber);

    if (!e164) {
      invalidPhoneNumberCount.value += 1;
      continue;
    }

    const mapping = toLocalTwilioStatus(record.status);
    inventory.set(e164, {
      phoneNumber: e164,
      status: mapping.status,
      rawStatus: mapping.rawStatus,
      isUnexpectedRawStatus: mapping.isUnexpectedRawStatus,
    });
  }

  return { inventory, invalidPhoneNumberCount: invalidPhoneNumberCount.value };
}

function filterInventoryByScope(
  inventory: Map<string, TwilioInventoryEntry>,
  phoneNumbers: string[] | undefined
) {
  if (!phoneNumbers?.length) {
    return inventory;
  }

  const targeted = new Set(phoneNumbers);
  return new Map([...inventory].filter(([phoneNumber]) => targeted.has(phoneNumber)));
}

function diffLocalRows(localRows: LocalNumberRow[], inventory: Map<string, TwilioInventoryEntry>) {
  const changes: StatusChange[] = [];
  const unexpectedRawStatuses: Array<{ phoneNumber: string; rawStatus: string | null }> = [];
  let unchangedCount = 0;
  let missingCount = 0;

  for (const row of localRows) {
    const twilioEntry = inventory.get(row.phone_number);
    const nextStatus: DatabaseTwilioStatus = twilioEntry?.status ?? "missing";

    if (!twilioEntry) {
      missingCount += 1;
    } else if (twilioEntry.isUnexpectedRawStatus) {
      unexpectedRawStatuses.push({ phoneNumber: row.phone_number, rawStatus: twilioEntry.rawStatus });
    }

    if (row.twilio_status === nextStatus) {
      unchangedCount += 1;
      continue;
    }

    changes.push({
      row,
      nextStatus,
      rawTwilioStatus: twilioEntry?.rawStatus ?? null,
      reason: twilioEntry ? "twilio-returned" : "twilio-missing",
    });
  }

  return { changes, unchangedCount, missingCount, unexpectedRawStatuses };
}

function summarizeChangedStatuses(changes: StatusChange[]) {
  const summary: Record<string, number> = {};

  for (const change of changes) {
    const key = `${change.row.twilio_status}->${change.nextStatus}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }

  return summary;
}

async function fetchTwilioInventory(input: SyncTwilioNumbersInput) {
  let twilioClient: TwilioClientLike;

  try {
    twilioClient = createTwilioClient() as TwilioClientLike;
  } catch (error) {
    logTwilioSyncError("twilio-config-failed", {
      requestId: input.requestId,
      scope: input.scope,
      phase: "twilio_config",
      details: safeErrorDetails(error),
    });
    throw toTwilioSyncError(error, { phase: "twilio_config", requestId: input.requestId, scope: input.scope });
  }

  try {
    logTwilioSync("twilio-list-start", {
      requestId: input.requestId,
      scope: input.scope,
      targetedCount: input.phoneNumbers?.length ?? 0,
    });
    const records = await twilioClient.incomingPhoneNumbers.list({ pageSize: 1000 });
    const { inventory, invalidPhoneNumberCount } = buildTwilioInventoryMap(records);
    const scopedInventory = filterInventoryByScope(inventory, input.phoneNumbers);

    logTwilioSync("twilio-list-complete", {
      requestId: input.requestId,
      scope: input.scope,
      twilioCount: scopedInventory.size,
      invalidPhoneNumberCount,
    });

    return scopedInventory;
  } catch (error) {
    logTwilioSyncError("twilio-list-failed", {
      requestId: input.requestId,
      scope: input.scope,
      phase: "twilio_list",
      details: safeErrorDetails(error),
    });
    throw toTwilioSyncError(error, { phase: "twilio_list", requestId: input.requestId, scope: input.scope });
  }
}

async function selectLocalNumbers(
  supabase: SupabaseClientLike,
  input: SyncTwilioNumbersInput
): Promise<LocalNumberRow[]> {
  try {
    let query = supabase
      .from("numbers")
      .select("id, phone_number, twilio_status, assignment_status, billing_status");

    if (input.scope === "targeted" && input.phoneNumbers?.length) {
      query = query.in("phone_number", input.phoneNumbers);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return data ?? [];
  } catch (error) {
    logTwilioSyncError("local-select-failed", {
      requestId: input.requestId,
      scope: input.scope,
      phase: "local_select",
      details: safeErrorDetails(error),
    });
    throw toTwilioSyncError(error, { phase: "local_select", requestId: input.requestId, scope: input.scope });
  }
}

async function persistStatusChange(
  supabase: SupabaseClientLike,
  input: SyncTwilioNumbersInput,
  change: StatusChange
) {
  const updatePayload = { twilio_status: change.nextStatus };

  const { error: updateError } = await supabase
    .from("numbers")
    .update(updatePayload)
    .eq("id", change.row.id);

  if (updateError) {
    throw toTwilioSyncError(updateError, {
      phase: "number_update",
      requestId: input.requestId,
      scope: input.scope,
      details: { numberId: change.row.id },
    });
  }

  const auditPayload: AuditLogInsert = {
    entity_type: "number",
    entity_id: change.row.id,
    action: "twilio_status_sync",
    actor_user_id: input.actorUserId,
    source: "twilio",
    old_values: { twilio_status: change.row.twilio_status },
    new_values: {
      twilio_status: change.nextStatus,
      requestId: input.requestId,
      scope: input.scope,
      reason: change.reason,
      rawTwilioStatus: change.rawTwilioStatus,
    },
  };

  const { error: auditError } = await supabase.from("audit_logs").insert(auditPayload);

  if (auditError) {
    throw toTwilioSyncError(auditError, {
      phase: "audit_insert",
      requestId: input.requestId,
      scope: input.scope,
      details: { numberId: change.row.id },
    });
  }
}

export async function syncTwilioNumbers(input: SyncTwilioNumbersInput): Promise<SyncTwilioNumbersResult> {
  const twilioInventory = await fetchTwilioInventory(input);
  const supabase = createAdminClient() as unknown as SupabaseClientLike;
  const localRows = await selectLocalNumbers(supabase, input);
  const { changes, unchangedCount, missingCount, unexpectedRawStatuses } = diffLocalRows(localRows, twilioInventory);
  const localPhoneNumbers = new Set(localRows.map((row) => row.phone_number));
  const upstreamOnlyCount = [...twilioInventory.keys()].filter((phoneNumber) => !localPhoneNumbers.has(phoneNumber)).length;

  logTwilioSync("diff-complete", {
    requestId: input.requestId,
    scope: input.scope,
    localCount: localRows.length,
    twilioCount: twilioInventory.size,
    changedCount: changes.length,
    unchangedCount,
    missingCount,
    upstreamOnlyCount,
    unexpectedRawStatusCount: unexpectedRawStatuses.length,
    changedStatuses: summarizeChangedStatuses(changes),
  });

  try {
    for (const change of changes) {
      await persistStatusChange(supabase, input, change);
    }
  } catch (error) {
    const syncError = toTwilioSyncError(error, {
      phase: error instanceof TwilioSyncError ? error.phase : "number_update",
      requestId: input.requestId,
      scope: input.scope,
    });
    logTwilioSyncError("write-failed", {
      requestId: input.requestId,
      scope: input.scope,
      phase: syncError.phase,
      details: syncError.details,
    });
    throw syncError;
  }

  const result: SyncTwilioNumbersResult = {
    requestId: input.requestId,
    scope: input.scope,
    localCount: localRows.length,
    twilioCount: twilioInventory.size,
    changedCount: changes.length,
    unchangedCount,
    missingCount,
    upstreamOnlyCount,
    unexpectedRawStatuses,
  };

  logTwilioSync("sync-complete", {
    ...result,
    unexpectedRawStatuses: unexpectedRawStatuses.slice(0, 20),
    unexpectedRawStatusCount: unexpectedRawStatuses.length,
    changedStatuses: summarizeChangedStatuses(changes),
  });

  return result;
}
