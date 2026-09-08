import { test, expect } from '@playwright/test';

test.describe('Race registration', () => {
  test('user should be able to register for a race', async ({ page }) => {
    await page.goto('https://qa.runtheday.com/find-a-race/');

    // Wait for the races list to load and click Register on the first available race
    // (the race title text is duplicated for a hidden mobile layout, so scope to the visible one)
    const raceCard = page.locator('p:visible', { hasText: 'Dummy Race' }).first();
    await expect(raceCard).toBeVisible({ timeout: 15000 });
    await raceCard
      .locator('xpath=ancestor::*[.//button[normalize-space()="Register"]][1]')
      .getByRole('button', { name: 'Register' })
      .first()
      .click();

    await expect(page).toHaveURL(/\/register\//);

    // Dismiss the race disclaimer dialog if present
    const agreeButton = page.getByRole('button', { name: 'Agree & Continue' });
    if (await agreeButton.isVisible().catch(() => false)) {
      await agreeButton.click();
    }

    // Fill in registrant details
    await page.getByTestId('first-name-field').fill('John');
    await page.getByTestId('last-name-field').fill('Doe');
    await page.getByTestId('email-field').fill('john.doe.test@example.com');
    await page.getByTestId('phone-field').fill('5551234567');
    await page.getByTestId('dob-field').fill('01/15/1990');
    await page.getByTestId('emergency-name-field').fill('Jane Doe');
    await page.getByTestId('emergency-phone-field').fill('5559876543');

    // Gender
    await page.getByRole('combobox', { name: 'Select Gender Select' }).first().click();
    await page.getByRole('option', { name: 'Male', exact: true }).click();

    // Address
    await page.getByTestId('address-field').click();
    await page.getByTestId('address-field').fill('New York');
    await page
      .getByRole('option', { name: 'New York NY, USA' })
      .click();

    // Event
    await page.getByText('Select Event', { exact: true }).click();
    await page.getByRole('option', { name: '5k' }).click();

    // Required custom question
    await page.locator('#question-select-0').click();
    await page.getByRole('option', { name: 'QA' }).click();

    // T-Shirt selection (required)
    await page.getByRole('button', { name: 'Add T-Shirt' }).click();
    await page.getByRole('combobox', { name: 'Select' }).first().click();
    await page.getByRole('option', { name: 'Pro-Fit - S ($100) (1000 Left)' }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    // Submit registration to proceed to the payment/review step
    await page.getByTestId('Pay-button').click();

    // Assert the registration flow succeeded: we land on the review/payment page
    // showing the submitted participant details
    await expect(page).toHaveURL(/\/register\/review_registration\//);
    await expect(page.getByText('John Doe')).toBeVisible();
    await expect(page.getByText('john.doe.test@example.com')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Checkout' })).toBeVisible();
  });
});
