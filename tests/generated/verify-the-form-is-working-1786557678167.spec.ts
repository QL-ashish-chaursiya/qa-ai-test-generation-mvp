import { test, expect } from '@playwright/test';

test.describe('Contact form', () => {
  test('should submit successfully with valid data', async ({ page }) => {
    await page.goto('https://clearvisit.app/contact');

    await page.getByRole('textbox', { name: 'First Name' }).fill('Ashish');
    await page.getByRole('textbox', { name: 'Last Name' }).fill('Chaurasiya');
    await page.getByRole('textbox', { name: 'Email' }).fill('chaurasiyaashish383@gmail.com');
    await page.getByRole('textbox', { name: 'Subject' }).fill('Test Inquiry');
    await page
      .getByRole('textbox', { name: 'Message' })
      .fill('This is a test message to verify the contact form is working correctly.');

    await page.getByRole('button', { name: 'Send Message' }).click();

    await expect(page.getByRole('heading', { name: 'Message Sent!' })).toBeVisible();
    await expect(page.getByText("We'll get back to you within 24 hours.")).toBeVisible();
  });
});
