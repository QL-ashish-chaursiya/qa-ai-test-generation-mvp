import { test, expect } from '@playwright/test';

test.describe('FAQ Management - Add, Edit, and Delete', () => {
  test('verify user able to add edit and delete faq', async ({ page }) => {
    // Navigate to login page
    await page.goto('https://admin.ztaygo.com/cms?tab=faqs');

    // Login with credentials
    await page.getByRole('textbox', { name: 'name@example.com' }).fill('ztaygo@admin.com');
    await page.getByRole('textbox', { name: '••••••••' }).fill('Ztaygo@4321');
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Wait for navigation and page to load
    await page.waitForURL('https://admin.ztaygo.com/cms');

    // Click Add FAQ button
    await page.getByRole('button', { name: 'Add FAQ' }).click();

    // Fill in FAQ details
    await page.getByRole('textbox', { name: 'Question' }).fill('Test Question for Automation');
    await page.getByRole('tabpanel', { name: 'Edit' }).getByRole('paragraph').fill('This is a test answer for the FAQ automation test.');

    // Create FAQ
    await page.getByRole('button', { name: 'Create FAQ' }).click();

    // Verify FAQ was created successfully
    await expect(page.getByRole('heading', { name: 'Test Question for Automation', level: 3 })).toBeVisible();

    // Click edit button on the newly created FAQ
    const faqItem = page.locator('generic').filter({ has: page.getByRole('heading', { name: 'Test Question for Automation' }) }).first();
    const editButton = faqItem.getByRole('button').nth(0);
    await editButton.click();

    // Update the question
    await page.getByRole('textbox', { name: 'Question' }).fill('Updated Test Question for Automation');
    await page.getByRole('button', { name: 'Update FAQ' }).click();

    // Verify FAQ was updated
    await expect(page.getByRole('heading', { name: 'Updated Test Question for Automation', level: 3 })).toBeVisible();

    // Click delete button
    const updatedFaqItem = page.locator('generic').filter({ has: page.getByRole('heading', { name: 'Updated Test Question for Automation' }) }).first();
    const deleteButton = updatedFaqItem.getByRole('button').nth(1);
    await deleteButton.click();

    // Handle confirmation dialog
    page.on('dialog', dialog => {
      expect(dialog.message()).toContain('Are you sure you want to delete this FAQ?');
      dialog.accept();
    });

    // Wait for deletion confirmation message
    await expect(page.locator('text=FAQ deleted successfully')).toBeVisible();

    // Verify FAQ was deleted - it should no longer appear in the list
    await expect(page.getByRole('heading', { name: 'Updated Test Question for Automation', level: 3 })).not.toBeVisible();
  });
});
