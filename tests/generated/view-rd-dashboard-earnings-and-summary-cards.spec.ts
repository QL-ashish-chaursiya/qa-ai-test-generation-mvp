import { test, expect } from '@playwright/test';

const EMAIL = 'ashishrandom@yopmail.com';
const PASSWORD = 'Ashish@123';

// Every summary card renders its label in a <p>, immediately followed by the
// element holding the value, so the label anchors the value lookup.
const cardValue = (label: string) => `p:text-is("${label}") + *`;

// The six cards that expose a "View reports" shortcut, and the Reports tab each opens.
// (Earnings and Coupons intentionally have no shortcut.)
const REPORT_LINKS = [
  { testId: 'registration-report-link', tab: 'registration' },
  { testId: 'donation-report-link', tab: 'donation' },
  { testId: 'volunteer-report-link', tab: 'volunteer' },
  { testId: 'tshirt-report-link', tab: 'tShirts' },
  { testId: 'addon-product-report-link', tab: 'addOnProducts' },
  { testId: 'ifp-report-link', tab: 'ifp' },
];

test.describe('Race director dashboard', () => {
  test('the dashboard of a published race shows the race analysis and summary cards with numeric values and working "View reports" links', async ({ page }) => {
    // Login plus a dashboard round trip per report shortcut needs more than the default budget
    test.setTimeout(180000);

    // The dashboard is RD-only, so sign in through the two-step login first
    await page.goto('https://qa.runtheday.com/account/login/');
    await page.getByTestId('email-field').fill(EMAIL);
    await page.getByTestId('continue-button').click();
    await page.getByTestId('password-field').fill(PASSWORD);
    await page.getByTestId('continue-button').click();
    await expect(page).toHaveURL(/\/races\//, { timeout: 30000 });

    // Selecting a published race points the whole "My Races" nav at that race id
    await page
      .getByTestId('race-card')
      .filter({ has: page.getByRole('button', { name: 'Published', exact: true }) })
      .first()
      .click();
    const dashboardLink = page.getByTestId('Dashboard-link');
    await expect(dashboardLink).toHaveAttribute('href', /^\/dashboard\/[0-9a-f]{24}\/$/, { timeout: 30000 });
    const dashboardPath = await dashboardLink.getAttribute('href');
    const dashboardUrl = `https://qa.runtheday.com${dashboardPath}`;

    await page.goto(dashboardUrl);
    await expect(page.getByText('Race Dashboard', { exact: true })).toBeVisible({ timeout: 30000 });

    // Race Analysis card - the page-view counter
    await expect(page.getByText('RACE ANALYSIS', { exact: true })).toBeVisible();
    await expect(page.locator(cardValue('RACE ANALYSIS'))).toHaveText(/^\d[\d,]*$/);
    await expect(page.getByText('Total Race Page View', { exact: true })).toBeVisible();

    // Currency cards
    await expect(page.getByText('EARNINGS', { exact: true })).toBeVisible();
    await expect(page.locator(cardValue('EARNINGS'))).toHaveText(/^\$\s*[\d,]+(\.\d{1,2})?$/);
    await expect(page.getByText('DONATIONS', { exact: true })).toBeVisible();
    await expect(page.locator(cardValue('DONATIONS'))).toHaveText(/^\$\s*[\d,]+(\.\d{1,2})?$/);

    // Plain count cards
    for (const label of ['REGISTRATIONS', 'VOLUNTEERS', 'ADD-ON PRODUCTS ORDERED', 'INDIVIDUAL FUNDRAISE PAGE']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
      await expect(page.locator(cardValue(label))).toHaveText(/^\d[\d,]*$/);
    }

    // Split cards report two numbers each
    await expect(page.getByText('T-SHIRTS ORDERED', { exact: true })).toBeVisible();
    await expect(page.locator(cardValue('T-SHIRTS ORDERED'))).toHaveText(/^\d[\d,]*\s+ordered\s+\d[\d,]*\s+remaining$/);
    await expect(page.getByText('COUPONS', { exact: true })).toBeVisible();
    await expect(page.locator(cardValue('COUPONS'))).toHaveText(/^\d[\d,]*\s+used\s+\d[\d,]*\s+remaining$/);

    // Exactly the six shortcut-bearing cards render a "View reports" link
    await expect(page.getByText('View reports')).toHaveCount(REPORT_LINKS.length);

    // Each shortcut opens the Reports page on its own tab for this race
    for (const { testId, tab } of REPORT_LINKS) {
      await page.goto(dashboardUrl);
      // Wait for the dashboard to finish rendering so the shortcut's handler is wired up
      await expect(page.getByText('Race Dashboard', { exact: true })).toBeVisible({ timeout: 30000 });
      const link = page.getByTestId(testId);
      await expect(link).toBeVisible();
      await expect(link).toHaveText('View reports');
      await link.click();
      await expect(page).toHaveURL(`https://qa.runtheday.com/reports/${dashboardPath!.split('/')[2]}/?tab=${tab}`, {
        timeout: 30000,
      });
    }
  });
});
