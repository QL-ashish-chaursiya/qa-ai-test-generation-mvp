import { test, expect } from '@playwright/test';

test.describe('Automation Practice Form', () => {
  test('should display success modal after submitting completed form', async ({ page }) => {
    // Navigate to the automation practice form
    await page.goto('https://demoqa.com/automation-practice-form');

    // Fill in First Name
    await page.getByRole('textbox', { name: 'First Name' }).fill('John');

    // Fill in Last Name
    await page.getByRole('textbox', { name: 'Last Name' }).fill('Doe');

    // Fill in Email
    await page.getByRole('textbox', { name: 'name@example.com' }).fill('john.doe@example.com');

    // Select Gender - Male
    await page.getByRole('radio', { name: 'Male', exact: true }).click();

    // Fill in Mobile Number (10 digits)
    await page.getByRole('textbox', { name: 'Mobile Number' }).fill('9876543210');

    // Fill in Date of Birth
    await page.locator('#dateOfBirthInput').fill('05 May 1990');

    // Select Subject - Maths
    await page.locator('#subjectsInput').click();
    await page.locator('#subjectsInput').fill('Maths');
    await page.getByRole('option', { name: 'Maths' }).click();

    // Select Hobbies - Sports
    await page.getByRole('checkbox', { name: 'Sports' }).click();

    // Fill in Current Address
    await page.getByRole('textbox', { name: 'Current Address' }).fill('123 Main Street, New York, NY 10001');

    // Select State - NCR
    await page.locator('#react-select-3-input').click();
    await page.locator('#react-select-3-input').fill('NCR');
    await page.getByRole('option', { name: 'NCR' }).click();

    // Select City - Delhi
    await page.locator('#react-select-4-input').click();
    await page.locator('#react-select-4-input').fill('Delhi');
    await page.getByRole('option', { name: 'Delhi' }).click();

    // Submit the form
    await page.getByRole('button', { name: 'Submit' }).click();

    // Verify the success modal appears with the thank you message
    const thankYouMessage = page.locator('text=Thanks for submitting the form');
    await expect(thankYouMessage).toBeVisible();
  });
});
