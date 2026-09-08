import { test, expect } from '@playwright/test';

test.describe('Race Registration', () => {
  test('should register user for race without payment gateway', async ({ page }) => {
    // Navigate to find-a-race page
    await page.goto('https://qa.runtheday.com/find-a-race/');
    await page.waitForLoadState('networkidle');

    // Click the first Register button
    await page.getByRole('button', { name: 'Register' }).first().click();
    await page.waitForLoadState('networkidle');

    // Fill in First Name
    await page.getByTestId('first-name-field').fill('John');

    // Fill in Last Name
    await page.getByTestId('last-name-field').fill('Doe');

    // Fill in Email
    await page.getByTestId('email-field').fill('john.doe@example.com');

    // Fill in Phone
    await page.getByTestId('phone-field').fill('5551234567');

    // Fill in Date of Birth
    await page.getByTestId('dob-field').fill('01/15/1990');

    // Select Gender
    await page.getByRole('combobox', { name: 'Select' }).nth(1).click();
    await page.getByRole('option', { name: 'Male', exact: true }).click();

    // Fill in Address
    await page.getByTestId('address-field').fill('New York');

    // Fill in Emergency Contact Name
    await page.getByTestId('emergency-name-field').fill('Jane Doe');

    // Fill in Emergency Contact Phone
    await page.getByTestId('emergency-phone-field').fill('5559876543');

    // Select Event
    await page.getByRole('combobox', { name: 'Select' }).nth(3).click();
    await page.getByRole('option', { name: '10k', exact: true }).click();

    // Uncheck donation checkbox to enable Skip & Pay button
    await page.getByTestId('donation-visibility-switch').click();

    // Wait for Skip & Pay button to be enabled
    const skipAndPayButton = page.getByRole('button', { name: 'Skip & Pay' });
    await skipAndPayButton.waitFor({ state: 'visible' });

    // Click Skip & Pay button to register without payment
    await skipAndPayButton.click();
    await page.waitForLoadState('networkidle');

    // Verify successful registration by checking for confirmation page or success message
    expect(page.url()).not.toContain('/register/');
  });
});
