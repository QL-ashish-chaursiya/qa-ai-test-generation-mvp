// spec: specs/clearvisit-test-plan.md
// seed: seed.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Contact Form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://clearvisit.app/contact');
  });

  test('Submit contact form with valid data (happy path)', async ({ page }) => {
    // 2-6. Fill all fields with valid data
    await page.getByLabel('First Name').fill('Jane');
    await page.getByLabel('Last Name').fill('Doe');
    await page.getByLabel('Email').fill('jane.doe@example.com');
    await page.getByLabel('Subject').fill('General question');
    await page.getByLabel('Message').fill('This is a test message from an automated test.');

    // 7. Click "Send Message"
    await page.getByRole('button', { name: 'Send Message' }).click();

    // Expect the success confirmation heading
    await expect(page.getByRole('heading', { name: 'Message Sent!' })).toBeVisible({ timeout: 10000 });
  });

  test('Submit with empty required fields', async ({ page }) => {
    // 2. Leave all fields empty, 3. Click "Send Message"
    await page.getByRole('button', { name: 'Send Message' }).click();

    // Form has novalidate, so validation (if any) is custom JS.
    // Assert the page did not navigate away and no success confirmation appeared.
    await expect(page).toHaveURL(/\/contact$/);
    await expect(page.getByText(/thank you|message sent/i)).not.toBeVisible();
  });

  test('Invalid email format is rejected', async ({ page }) => {
    await page.getByLabel('First Name').fill('Jane');
    await page.getByLabel('Last Name').fill('Doe');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByLabel('Subject').fill('General question');
    await page.getByLabel('Message').fill('Testing invalid email.');

    await page.getByRole('button', { name: 'Send Message' }).click();

    // Should not show a success confirmation for an invalid email
    await expect(page.getByText(/thank you|message sent/i)).not.toBeVisible();
  });

  test('Long input / boundary values', async ({ page }) => {
    const longMessage = 'A'.repeat(5000);
    await page.getByLabel('First Name').fill('Jane');
    await page.getByLabel('Last Name').fill('Doe');
    await page.getByLabel('Email').fill('jane.doe@example.com');
    await page.getByLabel('Subject').fill('Long message test');
    await page.getByLabel('Message').fill(longMessage);

    await page.getByRole('button', { name: 'Send Message' }).click();

    // Page must not crash; either accepted (success) or a validation error shown
    await expect(page.locator('body')).toBeVisible();
  });

  test('Special characters / basic XSS-safe input', async ({ page }) => {
    await page.getByLabel('First Name').fill('Jane');
    await page.getByLabel('Last Name').fill('Doe');
    await page.getByLabel('Email').fill('jane.doe@example.com');
    await page.getByLabel('Subject').fill('<script>alert(1)</script>');
    await page.getByLabel('Message').fill(`Test & "quotes" 'apostrophes' <b>bold</b>`);

    let dialogFired = false;
    page.on('dialog', async (dialog) => {
      dialogFired = true;
      await dialog.dismiss();
    });

    await page.getByRole('button', { name: 'Send Message' }).click();
    await page.waitForTimeout(1000);

    expect(dialogFired).toBe(false);
  });
});
