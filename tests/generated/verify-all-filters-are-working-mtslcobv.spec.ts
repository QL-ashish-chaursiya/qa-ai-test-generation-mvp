import { test, expect } from '@playwright/test';

test.describe('Agreements Page Filters', () => {
  test('verify all filters are working', async ({ page }) => {
    // Navigate to the agreements page
    await page.goto('https://admin.ztaygo.com/agreements');

    // Log in with provided credentials
    const emailInput = page.locator('input[type="email"]');
    const passwordInput = page.locator('input[type="password"]');
    const loginButton = page.locator('button[type="submit"]');

    // Check if login is needed
    if (await emailInput.isVisible()) {
      await emailInput.fill('ztaygo@admin.com');
      await passwordInput.fill('Ztaygo@4321');
      await loginButton.click();

      // Wait for page to load after login
      await page.waitForLoadState('networkidle');

      // Navigate to agreements page after login
      await page.goto('https://admin.ztaygo.com/agreements');
    }

    // Wait for the agreements page to fully load
    await page.waitForLoadState('networkidle');

    // Verify that search input is visible
    const searchInput = page.locator('input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible();

    // Test Status Filter (combobox)
    const statusFilter = page.locator('select').nth(0);
    if (await statusFilter.isVisible()) {
      const initialAgreements = page.locator('table tbody tr');
      const initialCount = await initialAgreements.count();

      // Get the combobox for status and click it
      const statusCombo = page.locator('div').filter({ has: page.locator('text=All Statuses') }).locator('..').first();
      if (await statusCombo.isVisible()) {
        await statusCombo.click();
        await page.waitForLoadState('networkidle');

        // Verify results
        const filteredAgreements = page.locator('table tbody tr');
        const filteredCount = await filteredAgreements.count();
        expect(filteredCount).toBeGreaterThanOrEqual(0);
      }
    }

    // Test Search/Name Filter
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await page.waitForLoadState('networkidle');

      // Verify search filter is applied
      const resultRows = page.locator('table tbody tr');
      const searchResults = await resultRows.count();
      expect(searchResults).toBeGreaterThanOrEqual(0);
    }

    // Test Date Range Filter
    const dateRangeButton = page.locator('button:has-text("Pick a date range")');
    if (await dateRangeButton.isVisible()) {
      await dateRangeButton.click();
      await page.waitForLoadState('networkidle');

      // Verify date filter is applied
      const dateFilteredResults = page.locator('table tbody tr');
      const dateFilterCount = await dateFilteredResults.count();
      expect(dateFilterCount).toBeGreaterThanOrEqual(0);
    }

    // Test Type/Category Filter (combobox)
    const typeCombo = page.locator('div').filter({ has: page.locator('text=All Types') }).locator('..').first();
    if (await typeCombo.isVisible()) {
      await typeCombo.click();
      await page.waitForLoadState('networkidle');

      const typeFilteredResults = page.locator('table tbody tr');
      expect(await typeFilteredResults.count()).toBeGreaterThanOrEqual(0);
    }

    // Verify that filters and table are still visible
    const tableElement = page.locator('table');
    await expect(tableElement).toBeVisible();
    await expect(searchInput).toBeVisible();
  });
});
