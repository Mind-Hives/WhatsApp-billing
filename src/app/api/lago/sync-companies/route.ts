import { requireAdminUser } from "@/lib/auth/admin";
import {
  createOrUpdateCustomerForCompany,
  createSubscriptionIfMissing,
  type LagoCompany,
} from "@/lib/lago/client";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

export async function POST() {
  const auth = await requireAdminUser();
  if (auth.error) {
    return auth.error;
  }

  const supabase = createAdminClient();
  const { data: companies, error } = await supabase
    .from("companies")
    .select("id, name, billing_email, lago_customer_id, lago_external_customer_id, lago_subscription_id")
    .eq("billing_status", "active");
  if (error) {
    throw error;
  }

  const results = [];
  for (const company of (companies ?? []) as LagoCompany[]) {
    try {
      const customer = await createOrUpdateCustomerForCompany(company);
      const lagoCustomerId = customer.customer?.lago_id ?? company.lago_customer_id;
      const externalCustomerId = customer.customer?.external_id ?? company.lago_external_customer_id ?? company.id;
      const subscription = await createSubscriptionIfMissing({
        ...company,
        lago_customer_id: lagoCustomerId,
        lago_external_customer_id: externalCustomerId,
      });
      const lagoSubscriptionId = subscription.subscription?.external_id ?? company.lago_subscription_id;

      await supabase
        .from("companies")
        .update({
          lago_customer_id: lagoCustomerId,
          lago_external_customer_id: externalCustomerId,
          lago_subscription_id: lagoSubscriptionId,
        })
        .eq("id", company.id);

      await supabase.from("audit_logs").insert({
        actor_type: "admin",
        actor_id: auth.user.id,
        action: "lago_company_sync",
        entity_type: "company",
        entity_id: company.id,
        source: "lago",
        new_values: {
          lago_customer_id: lagoCustomerId,
          lago_external_customer_id: externalCustomerId,
          lago_subscription_id: lagoSubscriptionId,
        },
      });

      results.push({ companyId: company.id, status: "sent", lagoCustomerId });
    } catch (syncError) {
      results.push({
        companyId: company.id,
        status: "failed",
        errorMessage: syncError instanceof Error ? syncError.message : "Lago sync failed",
      });
    }
  }

  return Response.json({ data: { totalCompanies: results.length, results } });
}
