import { test, expect } from '@playwright/test';

test.describe('Contact Form', () => {
  test('Submit contact form with valid data shows success confirmation', async ({ page }) => {
    await page.goto('https://clearvisit.app/contact');

    await page.getByLabel('First Name').fill('Ashish');
    await page.getByLabel('Last Name').fill('Chaurasiya');
    await page.getByLabel('Email').fill('chaurasiyaashish383@gmail.com');
    await page.getByLabel('Subject').fill('Test Inquiry');
    await page.getByLabel('Message').fill('This is a test message to verify the contact form is working.');

    await page.getByRole('button', { name: 'Send Message' }).click();

    await expect(page.getByRole('heading', { name: 'Message Sent!' })).toBeVisible({ timeout: 10000 });
  });
});
