// spec: specs/clearvisit-test-plan.md
// seed: seed.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Privacy Policy Page', () => {
  test('Privacy policy loads and is readable', async ({ page }) => {
    // 1. Navigate to /privacy-policy
    await page.goto('https://clearvisit.app/privacy-policy');

    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.locator('body')).toContainText(/privacy/i);
  });
});
