import type { NextRequest } from "next/server";
import { validateEnvelope } from "@/features/imports/contract";
import { stageBatch } from "@/features/imports/stage-batch";

// Validates Bearer token against N8N_IMPORT_SECRET without logging the token value.
function checkAuth(request: NextRequest): boolean {
  const secret = process.env.N8N_IMPORT_SECRET;
  if (!secret) {
    console.error("[imports] N8N_IMPORT_SECRET is not configured");
    return false;
  }
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice(7);
  return token === secret;
}

export async function POST(request: NextRequest) {
  // Auth check runs before any body reads — unauthorized requests write nothing.
  if (!checkAuth(request)) {
    console.log("[imports] auth rejected");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse JSON body — invalid JSON returns 400, not 422.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    console.log("[imports] invalid JSON body");
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate envelope (sourceRunId, rows) before touching staging tables.
  const envelopeError = validateEnvelope(body);
  if (envelopeError) {
    console.log(`[imports] envelope rejected: ${envelopeError}`);
    return Response.json({ error: envelopeError }, { status: 422 });
  }

  const { sourceRunId, rows } = body as { sourceRunId: string; rows: unknown[] };

  try {
    const result = await stageBatch({ sourceRunId, rows });
    const status = result.duplicate ? 200 : 201;
    console.log(
      `[imports] ${result.duplicate ? "replay" : "staged"} source_run_id=${sourceRunId} batch_id=${result.batchId} row_count=${result.rowCount} valid=${result.validRowCount} invalid=${result.invalidRowCount}`
    );
    return Response.json(result, { status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[imports] staging failed source_run_id=${sourceRunId}: ${message}`
    );
    return Response.json({ error: "Staging failed" }, { status: 500 });
  }
}
