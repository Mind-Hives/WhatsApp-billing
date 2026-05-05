import { test, expect } from '@playwright/test'

test('renders the local scaffold homepage', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle(/Billing Admin/)
  await expect(
    page.getByRole('heading', { name: 'Billing Admin scaffold' })
  ).toBeVisible()
  await expect(page.getByText(/scaffold ready/i)).toBeVisible()
})
