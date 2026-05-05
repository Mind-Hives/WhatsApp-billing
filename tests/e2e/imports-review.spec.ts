import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SECRET = process.env.N8N_IMPORT_SECRET ?? "test-import-secret-local";
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "password123456";

const sourceRunId = `review-e2e-${Date.now()}`;
const visibleSourceRunPrefix = `${sourceRunId.slice(0, 12)}…`;

function uniquePhoneNumber() {
  return `555${Date.now().toString().slice(-7)}`;
}

async function ensureAdminUser() {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for imports-review E2E auth setup.");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) {
    throw listError;
  }

  const existingUser = existingUsers.users.find((user) => user.email === ADMIN_EMAIL);
  if (existingUser) {
    const { error } = await supabase.auth.admin.updateUserById(existingUser.id, {
      email_confirm: true,
      password: ADMIN_PASSWORD,
    });
    if (error) {
      throw error;
    }
    return;
  }

  const { error } = await supabase.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
  });
  if (error) {
    throw error;
  }
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login?redirectedFrom=%2Fdashboard%2Fimports");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard\/imports$/);
}

test.describe.serial("imports review dashboard", () => {
  test.beforeAll(async ({ request }) => {
    await ensureAdminUser();

    const res = await request.post("/api/imports/n8n", {
      data: {
        sourceRunId,
        rows: [
          {
            companyName: `Review E2E Co ${Date.now()}`,
            phoneNumber: uniquePhoneNumber(),
            userEmail: "review-e2e@example.com",
          },
          {
            companyName: "",
            phoneNumber: uniquePhoneNumber(),
          },
        ],
      },
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
    });

    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({
      duplicate: false,
      rowCount: 2,
      validRowCount: 1,
      invalidRowCount: 1,
    });
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("page renders batch list", async ({ page }) => {
    const newestBatch = page.locator("article").first();

    await expect(newestBatch).toContainText(visibleSourceRunPrefix);
    await expect(newestBatch).toContainText("2 total / 1 valid / 1 invalid");
    await expect(newestBatch.getByText("staged")).toBeVisible();
    await expect(
      newestBatch.getByRole("button", { name: "Commit valid rows" })
    ).toBeVisible();
  });

  test("commit changes batch to committed", async ({ page }) => {
    const newestBatch = page.locator("article").first();

    await expect(newestBatch).toContainText(visibleSourceRunPrefix);
    await newestBatch.getByRole("button", { name: "Commit valid rows" }).click();

    await expect(newestBatch.getByText("committed")).toBeVisible();
    await expect(
      newestBatch.getByRole("button", { name: "Commit valid rows" })
    ).toHaveCount(0);
  });

  test("re-committing is idempotent", async ({ page }) => {
    await page.reload();
    const newestBatch = page.locator("article").first();

    await expect(newestBatch).toContainText(visibleSourceRunPrefix);
    await expect(newestBatch.getByText("committed")).toBeVisible();
    await expect(
      newestBatch.getByRole("button", { name: "Commit valid rows" })
    ).toHaveCount(0);
  });
});

test("unauthenticated access redirects", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/dashboard/imports");

  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await expect(page).toHaveURL(/redirectedFrom=%2Fdashboard%2Fimports/);
  await context.close();
});
