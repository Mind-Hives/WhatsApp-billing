import { expect, test } from "@playwright/test";

test("redirects unauthenticated dashboard requests to /login", async ({
  page,
}) => {
  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await expect(page).toHaveURL(/redirectedFrom=%2Fdashboard/);
  await expect(
    page.getByRole("heading", { name: "Sign in to Billing Admin" })
  ).toBeVisible();
});

test("shows a generic error message for invalid login attempts", async ({
  page,
}) => {
  await page.goto("/login");

  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(
    page.getByText("We couldn’t sign you in. Check your credentials and try again.")
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
});
