import { test, expect } from '@playwright/test';

const RACE_NAME = 'Dummy Race';
const PRODUCT_NAME = 'Drinking Bottle';
const PRODUCT_SIZE = 'M';

// Prices are rendered with the amount separated from the "$" and occasionally with
// non-breaking spaces, so compare on the numeric value instead of the raw string.
const priceOf = (text: string) => Number(text.replace(/[^0-9.]/g, ''));

test.describe('Registration add-on products', () => {
  test('adding an add-on product marks it as added for the participant with its price', async ({ page }) => {
    // Two page loads plus a debounced search - the default 30s budget is tight
    test.setTimeout(120000);

    await page.goto('https://qa.runtheday.com/find-a-race/');

    // Narrow the listing down to the race that has add-on products enabled
    const raceCard = page.locator('div.cursor-pointer.bg-primary-black-800');
    await expect(raceCard.first()).toBeVisible({ timeout: 30000 });
    await page.getByTestId('search-event-field').fill(RACE_NAME);
    await expect(async () => {
      await expect(raceCard).toHaveCount(1);
      await expect(raceCard).toContainText(RACE_NAME);
    }).toPass({ timeout: 20000 });

    await raceCard.getByRole('button', { name: 'Register' }).click();
    await expect(page).toHaveURL(/\/register\/\d+\//, { timeout: 30000 });

    // The race disclaimer only shows the first time this race is opened in a context
    const agreeButton = page.getByRole('button', { name: 'Agree & Continue' });
    if (await agreeButton.isVisible().catch(() => false))
      await agreeButton.click();

    // The participant form - and with it the Add-on Products section - only renders
    // once a registration type is picked
    await page.getByRole('radio', { name: 'Early Registration' }).click();

    const addOnSection = page.getByText('Add-on Products', { exact: true }).locator('xpath=..');
    await expect(addOnSection).toBeVisible({ timeout: 30000 });

    // The product as offered in the catalogue, with the price the summary must echo
    const productCard = addOnSection
      .getByText(PRODUCT_NAME, { exact: true })
      .locator('xpath=ancestor::div[.//button[@data-testid="add-button"]][1]');
    await expect(productCard).toBeVisible();
    const catalogPrice = priceOf(await productCard.locator('p').filter({ hasText: /^\$/ }).innerText());
    expect(catalogPrice).toBe(1);

    await productCard.getByTestId('add-button').click();

    // Picking a size / quantity is what actually attaches the product to the participant
    const productPanel = page.getByRole('tabpanel').filter({ hasText: PRODUCT_NAME });
    await expect(productPanel).toBeVisible();
    const sizeStepper = productPanel.locator(
      `xpath=.//p[normalize-space()="${PRODUCT_SIZE}"]/following-sibling::div[1]`,
    );
    await sizeStepper.getByTestId('plus-icon').click();
    await expect(sizeStepper).toContainText('1');

    const saveButton = page.getByTestId('save-button');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    // The product is now marked as added for the participant: it has moved out of the
    // catalogue into the participant's order summary, where it can only be edited/removed
    const summaryRow = addOnSection.getByRole('row').filter({ hasText: PRODUCT_NAME });
    await expect(summaryRow).toHaveCount(1);
    await expect(summaryRow).toBeVisible();
    await expect(productCard).toHaveCount(0);

    const cells = summaryRow.getByRole('cell');
    await expect(cells.nth(1)).toHaveText(PRODUCT_NAME);
    await expect(cells.nth(3)).toHaveText('1');
    await expect(cells.nth(4)).toHaveText(PRODUCT_SIZE);
    await expect(summaryRow.getByText('Remove', { exact: true })).toBeVisible();

    // ...and its price is carried over from the catalogue into that summary
    expect(priceOf(await cells.nth(2).innerText())).toBe(catalogPrice);
  });
});
