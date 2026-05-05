import { createAdminClient } from "@/utils/supabase/admin";

export type LagoCompany = {
  id: string;
  name: string;
  billing_email: string | null;
  lago_customer_id: string | null;
  lago_external_customer_id: string | null;
  lago_subscription_id: string | null;
};

type LagoCustomerResponse = {
  customer?: {
    lago_id?: string;
    external_id?: string;
  };
};

type LagoSubscriptionResponse = {
  subscription?: {
    lago_id?: string;
    external_id?: string;
  };
};

type LagoEventResponse = {
  event?: {
    lago_id?: string;
    transaction_id?: string;
  };
};

function lagoConfig() {
  const apiUrl = process.env.LAGO_API_URL;
  const apiKey = process.env.LAGO_API_KEY;
  const planCode = process.env.LAGO_WHATSAPP_PLAN_CODE;
  const billableMetricCode = process.env.LAGO_WHATSAPP_BILLABLE_METRIC_CODE;

  if (!apiUrl || !apiKey || !planCode || !billableMetricCode) {
    throw new Error(
      "Missing Lago configuration. Required: LAGO_API_URL, LAGO_API_KEY, LAGO_WHATSAPP_PLAN_CODE, LAGO_WHATSAPP_BILLABLE_METRIC_CODE."
    );
  }

  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    apiKey,
    planCode,
    billableMetricCode,
  };
}

function subscriptionExternalId(companyId: string) {
  return `whatsapp-numbers-${companyId}`;
}

async function lagoFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const config = lagoConfig();
  const response = await fetch(`${config.apiUrl}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 404) {
    throw Object.assign(new Error(`Lago resource not found: ${path}`), {
      status: 404,
    });
  }

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw Object.assign(new Error(`Lago API request failed: ${response.status}`), {
      status: response.status,
      body: json,
    });
  }

  return json as T;
}

export async function getCustomerByExternalId(externalId: string) {
  try {
    return await lagoFetch<LagoCustomerResponse>(
      `/customers/${encodeURIComponent(externalId)}`
    );
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return null;
    }
    throw error;
  }
}

export async function createOrUpdateCustomerForCompany(company: LagoCompany) {
  const externalId = company.lago_external_customer_id ?? company.id;
  return lagoFetch<LagoCustomerResponse>("/customers", {
    method: "POST",
    body: JSON.stringify({
      customer: {
        external_id: externalId,
        name: company.name,
        legal_name: company.name,
        email: company.billing_email,
        currency: "USD",
      },
    }),
  });
}

async function getSubscriptionByExternalId(externalId: string) {
  try {
    return await lagoFetch<LagoSubscriptionResponse>(
      `/subscriptions/${encodeURIComponent(externalId)}`
    );
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return null;
    }
    throw error;
  }
}

export async function createSubscriptionIfMissing(company: LagoCompany) {
  const config = lagoConfig();
  const externalCustomerId = company.lago_external_customer_id ?? company.id;
  const externalSubscriptionId =
    company.lago_subscription_id ?? subscriptionExternalId(company.id);
  const existing = await getSubscriptionByExternalId(externalSubscriptionId);
  if (existing?.subscription) {
    return existing;
  }

  return lagoFetch<LagoSubscriptionResponse>("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      subscription: {
        external_customer_id: externalCustomerId,
        external_id: externalSubscriptionId,
        plan_code: config.planCode,
        name: `${company.name} WhatsApp numbers`,
        billing_time: "calendar",
      },
    }),
  });
}

export async function sendWhatsAppNumberUsage(
  companyId: string,
  billingMonth: string,
  quantity: number,
  idempotencyKey: string
) {
  const config = lagoConfig();
  const supabase = createAdminClient();
  const { data: company, error } = await supabase
    .from("companies")
    .select("id, name, billing_email, lago_customer_id, lago_external_customer_id, lago_subscription_id")
    .eq("id", companyId)
    .single<LagoCompany>();
  if (error || !company) {
    throw error ?? new Error("Company not found");
  }

  const externalSubscriptionId =
    company.lago_subscription_id ?? subscriptionExternalId(company.id);
  const timestamp = Math.floor(
    Date.parse(`${billingMonth}-01T00:00:00.000Z`) / 1000
  );

  return lagoFetch<LagoEventResponse>("/events", {
    method: "POST",
    body: JSON.stringify({
      event: {
        transaction_id: idempotencyKey,
        external_subscription_id: externalSubscriptionId,
        code: config.billableMetricCode,
        timestamp,
        properties: {
          quantity,
          active_whatsapp_numbers: quantity,
        },
      },
    }),
  });
}

export async function fetchInvoicesForCompany(companyId: string) {
  const supabase = createAdminClient();
  const { data: company, error } = await supabase
    .from("companies")
    .select("lago_external_customer_id")
    .eq("id", companyId)
    .single<{ lago_external_customer_id: string | null }>();
  if (error || !company?.lago_external_customer_id) {
    throw error ?? new Error("Company has no Lago external customer ID");
  }

  return lagoFetch(
    `/invoices?external_customer_id=${encodeURIComponent(company.lago_external_customer_id)}`
  );
}

export async function fetchInvoice(invoiceId: string) {
  return lagoFetch(`/invoices/${encodeURIComponent(invoiceId)}`);
}

export function getLagoUnitAmount() {
  return Number(process.env.LAGO_WHATSAPP_UNIT_AMOUNT ?? "5");
}
