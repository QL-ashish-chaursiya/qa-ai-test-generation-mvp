import { test, expect } from '@playwright/test';

test.describe('Contact page', () => {
  test('should display the "Contact Us" heading', async ({ page }) => {
    await page.goto('https://clearvisit.app/contact');

    const heading = page.getByRole('heading', { name: 'Contact Us', level: 1 });
    await expect(heading).toBeVisible();
  });
});
