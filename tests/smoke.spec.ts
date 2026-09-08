// spec: specs/clearvisit-test-plan.md
// seed: seed.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Cross-cutting Smoke Checks', () => {
  test('No console errors across pages', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    for (const path of ['/', '/contact', '/privacy-policy']) {
      await page.goto(`https://clearvisit.app${path}`);
      await page.waitForTimeout(500);
    }

    expect(errors).toEqual([]);
  });

  test('Direct deep-link navigation', async ({ page }) => {
    // 1. Navigate directly to /contact
    const contactResponse = await page.goto('https://clearvisit.app/contact');
    expect(contactResponse?.status()).toBeLessThan(400);
    await expect(page.getByRole('heading', { name: 'Contact Us' })).toBeVisible();

    // 2. Navigate directly to /privacy-policy
    const privacyResponse = await page.goto('https://clearvisit.app/privacy-policy');
    expect(privacyResponse?.status()).toBeLessThan(400);
  });
});
