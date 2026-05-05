import { requireAdminUser } from "@/lib/auth/admin";
import { runBillingSync } from "@/features/billing/sync-to-lago";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireAdminUser();
  if (auth.error) {
    return auth.error;
  }

  const body = await request.json().catch(() => null);
  if (
    !body ||
    typeof body.billingMonth !== "string" ||
    typeof body.idempotencyKey !== "string"
  ) {
    return Response.json(
      { error: "billingMonth and idempotencyKey are required." },
      { status: 422 }
    );
  }

  const summary = await runBillingSync({
    billingMonth: body.billingMonth,
    idempotencyKey: body.idempotencyKey,
  });

  return Response.json({ data: summary });
}
