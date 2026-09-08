import { test, expect } from '@playwright/test';

const EMAIL = 'ashishrandom@yopmail.com';
const PASSWORD = 'Ashish@123';

const RACE_NAME = 'Automation Test Race 2026';

// The Registrations report table, in the order the RD sees the columns
const REGISTRATION_COLUMNS = [
  'First Name',
  'Last Name',
  'Phone',
  'Email',
  'Registration type',
  'RTD registrations',
  'Non-RTD registrations',
  'Gender',
  'Age',
  'Event',
  'Source',
  'Actions',
];

// Each report tab pushes its own ?tab= value and renders its own titled table.
// "Payment Links" is deliberately skipped - it is not part of this scenario.
const REPORT_TABS = [
  { testId: 'Donations-tab', tab: 'donation', heading: 'Donation Reports', firstColumn: 'Name' },
  { testId: 'Volunteers-tab', tab: 'volunteer', heading: 'Volunteers Reports', firstColumn: 'Name' },
  { testId: 'T-Shirts-tab', tab: 'tShirts', heading: 'T-Shirt Reports', firstColumn: 'T Shirt' },
  {
    testId: 'Individual-Fundraising-Pages-tab',
    tab: 'ifp',
    heading: 'Individual Fundraising Reports',
    firstColumn: 'Name of fundraising page',
  },
  {
    testId: 'Add-on-Products-tab',
    tab: 'addOnProducts',
    heading: 'Add on products Reports',
    firstColumn: 'Name',
  },
  { testId: 'Transactions-tab', tab: 'transactions', heading: 'Transaction Reports', firstColumn: 'Name' },
];

test.describe('Race director reports', () => {
  test('the Registrations report renders every column and each report tab loads without error', async ({ page }) => {
    // Two-step login plus a report page that fetches a table per tab
    test.setTimeout(120000);

    await page.goto('https://qa.runtheday.com/account/login/');

    // Reports live behind the RD login, so sign in first
    await page.getByTestId('email-field').fill(EMAIL);
    await page.getByTestId('continue-button').click();
    await page.getByTestId('password-field').fill(PASSWORD);
    await page.getByTestId('continue-button').click();

    await expect(page).toHaveURL(/\/races\//, { timeout: 30000 });
    await expect(page.getByText('My Races', { exact: true })).toBeVisible({ timeout: 30000 });

    // Reports must be opened for a published race - the sidebar also lists drafts
    const publishedRace = page
      .getByTestId('race-card')
      .filter({ has: page.getByTestId('satus-button').filter({ hasText: /^Published$/ }) })
      .first();
    await expect(publishedRace).toBeVisible({ timeout: 30000 });
    await expect(publishedRace).toContainText(RACE_NAME);
    await publishedRace.click();
    await expect(page).toHaveURL(/\/races\/[0-9a-f]{24}\//, { timeout: 30000 });

    await page.getByTestId('Reports-link').click();

    // Reports opens on the Registrations tab by default
    await expect(page).toHaveURL(/\/reports\/[0-9a-f]{24}\/\?tab=registration$/, { timeout: 30000 });

    // Only one tab panel is rendered at a time - the rest carry the `hidden` attribute
    const activePanel = page.locator('[role="tabpanel"]:not([hidden])');
    await expect(activePanel.getByText('Registration Reports', { exact: true })).toBeVisible({ timeout: 30000 });

    // The Registrations table exposes the full column set, in order
    const registrationHeaders = activePanel.getByRole('table').getByRole('columnheader');
    await expect(registrationHeaders).toHaveText(REGISTRATION_COLUMNS);

    // Switching tabs loads each report: the tab is selected, the URL carries its
    // key and the panel renders that report's own table rather than an error
    for (const { testId, tab, heading, firstColumn } of REPORT_TABS) {
      const tabButton = page.getByTestId(testId);
      await tabButton.click();

      await expect(page).toHaveURL(new RegExp(`\\?tab=${tab}$`), { timeout: 30000 });
      await expect(tabButton).toHaveAttribute('aria-selected', 'true');

      await expect(activePanel.getByText(heading, { exact: true })).toBeVisible({ timeout: 30000 });

      const table = activePanel.getByRole('table');
      await expect(table).toBeVisible();
      await expect(table.getByRole('columnheader').first()).toHaveText(firstColumn);

      // A failed report render would replace the table with an error state
      await expect(activePanel).not.toContainText(/something went wrong|failed to load|error/i);
    }
  });
});
