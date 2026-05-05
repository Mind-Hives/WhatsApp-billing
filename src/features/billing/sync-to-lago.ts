import {
  createOrUpdateCustomerForCompany,
  createSubscriptionIfMissing,
  getLagoUnitAmount,
  sendWhatsAppNumberUsage,
  type LagoCompany,
} from "@/lib/lago/client";
import { createAdminClient } from "@/utils/supabase/admin";

export interface BillingSyncInput {
  billingMonth: string;
  idempotencyKey: string;
}

export interface BillingSyncSummary {
  billingMonth: string;
  totalCompanies: number;
  totalBillableNumbers: number;
  totalEstimatedAmount: number;
  perCompany: Array<{
    companyId: string;
    companyName: string;
    quantity: number;
    estimatedAmount: number;
    lagoCustomerId: string | null;
    status: string;
    errorMessage?: string | null;
  }>;
}

type CompanyWithAssignments = LagoCompany & {
  number_assignments: Array<{ phone_number_id: string }>;
};

type ExistingBillingSyncItem = {
  company_id: string;
  active_billable_number_count: number;
  estimated_amount: number | string;
  lago_customer_id: string | null;
  status: string;
  error_message: string | null;
  companies: { name: string } | Array<{ name: string }> | null;
};

function companyNameFromRelation(companies: ExistingBillingSyncItem["companies"]) {
  if (Array.isArray(companies)) {
    return companies[0]?.name ?? "Unknown";
  }

  return companies?.name ?? "Unknown";
}

export async function getBillableCountsByCompany() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select(
      "id, name, billing_email, lago_customer_id, lago_external_customer_id, lago_subscription_id, number_assignments!inner(phone_number_id, status, assigned_to, phone_numbers!inner(billing_status))"
    )
    .eq("billing_status", "active")
    .eq("number_assignments.status", "active")
    .is("number_assignments.assigned_to", null)
    .eq("number_assignments.phone_numbers.billing_status", "billable");
  if (error) {
    throw error;
  }

  return ((data ?? []) as CompanyWithAssignments[]).map((company) => ({
    ...company,
    quantity: new Set(company.number_assignments.map((item) => item.phone_number_id)).size,
  }));
}

export async function runBillingSync(input: BillingSyncInput): Promise<BillingSyncSummary> {
  if (!/^\d{4}-\d{2}$/.test(input.billingMonth)) {
    throw new Error("billingMonth must use YYYY-MM format");
  }

  const supabase = createAdminClient();
  const unitAmount = getLagoUnitAmount();

  const { data: existingRun, error: existingError } = await supabase
    .from("billing_sync_runs")
    .select("id, billing_month, status, total_companies, total_billable_numbers, total_estimated_amount, billing_sync_items(company_id, active_billable_number_count, estimated_amount, lago_customer_id, status, error_message, companies(name))")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existingError) {
    throw existingError;
  }
  if (existingRun) {
    return {
      billingMonth: existingRun.billing_month,
      totalCompanies: existingRun.total_companies,
      totalBillableNumbers: existingRun.total_billable_numbers,
      totalEstimatedAmount: Number(existingRun.total_estimated_amount),
      perCompany: (
        (existingRun.billing_sync_items ?? []) as ExistingBillingSyncItem[]
      ).map((item) => ({
        companyId: item.company_id,
        companyName: companyNameFromRelation(item.companies),
        quantity: item.active_billable_number_count,
        estimatedAmount: Number(item.estimated_amount),
        lagoCustomerId: item.lago_customer_id,
        status: item.status,
        errorMessage: item.error_message,
      })),
    };
  }

  const companies = await getBillableCountsByCompany();
  const totalBillableNumbers = companies.reduce((sum, company) => sum + company.quantity, 0);
  const totalEstimatedAmount = totalBillableNumbers * unitAmount;

  const { data: run, error: runError } = await supabase
    .from("billing_sync_runs")
    .insert({
      billing_month: input.billingMonth,
      idempotency_key: input.idempotencyKey,
      status: "pending",
      total_companies: companies.length,
      total_billable_numbers: totalBillableNumbers,
      total_estimated_amount: totalEstimatedAmount,
    })
    .select("id")
    .single<{ id: string }>();
  if (runError || !run) {
    throw runError ?? new Error("Billing sync run insert returned no row");
  }

  const perCompany: BillingSyncSummary["perCompany"] = [];
  let failed = 0;

  for (const company of companies) {
    const estimatedAmount = company.quantity * unitAmount;
    let status: "sent" | "failed" = "sent";
    let errorMessage: string | null = null;
    let lagoCustomerId = company.lago_customer_id;
    let lagoEventId: string | null = null;

    try {
      const customer = await createOrUpdateCustomerForCompany(company);
      lagoCustomerId = customer.customer?.lago_id ?? lagoCustomerId;
      const externalCustomerId = customer.customer?.external_id ?? company.lago_external_customer_id ?? company.id;
      const subscription = await createSubscriptionIfMissing({
        ...company,
        lago_customer_id: lagoCustomerId,
        lago_external_customer_id: externalCustomerId,
      });

      await supabase
        .from("companies")
        .update({
          lago_customer_id: lagoCustomerId,
          lago_external_customer_id: externalCustomerId,
          lago_subscription_id: subscription.subscription?.external_id ?? company.lago_subscription_id,
        })
        .eq("id", company.id);

      const event = await sendWhatsAppNumberUsage(
        company.id,
        input.billingMonth,
        company.quantity,
        `${input.idempotencyKey}:${company.id}`
      );
      lagoEventId = event.event?.lago_id ?? event.event?.transaction_id ?? null;
    } catch (error) {
      failed += 1;
      status = "failed";
      errorMessage = error instanceof Error ? error.message : "Lago sync failed";
    }

    await supabase.from("billing_sync_items").insert({
      run_id: run.id,
      company_id: company.id,
      active_billable_number_count: company.quantity,
      estimated_amount: estimatedAmount,
      lago_customer_id: lagoCustomerId,
      lago_event_id: lagoEventId,
      status,
      error_message: errorMessage,
    });

    perCompany.push({
      companyId: company.id,
      companyName: company.name,
      quantity: company.quantity,
      estimatedAmount,
      lagoCustomerId,
      status,
      errorMessage,
    });
  }

  const finalStatus = failed === 0 ? "sent" : failed === companies.length ? "failed" : "partial";
  await supabase
    .from("billing_sync_runs")
    .update({
      status: finalStatus,
      completed_at: new Date().toISOString(),
      error_message: failed > 0 ? `${failed} company sync(s) failed` : null,
    })
    .eq("id", run.id);

  return {
    billingMonth: input.billingMonth,
    totalCompanies: companies.length,
    totalBillableNumbers,
    totalEstimatedAmount,
    perCompany,
  };
}
