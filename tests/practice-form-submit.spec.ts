// spec: Fill all fields on the DemoQA Automation Practice Form and verify the
// confirmation modal appears after submission.
// seed: seed.spec.ts
import path from 'path';
import { test, expect } from '@playwright/test';

test.describe('Automation Practice Form', () => {
  test('Fill all fields and submit shows confirmation modal', async ({ page }) => {
    await page.goto('https://demoqa.com/automation-practice-form');

    // DemoQA renders ad banners/iframes that overlap the form on real viewports;
    // remove them so clicks land on the actual form controls.
    await page.evaluate(() => {
      document.querySelectorAll('#fixedban, .ad, iframe[id^="google_ads"]').forEach((el) => el.remove());
    });

    // Name
    await page.locator('#firstName').fill('Jane');
    await page.locator('#lastName').fill('Doe');

    // Email
    await page.locator('#userEmail').fill('jane.doe@example.com');

    // Gender (radio input is visually hidden; click its label)
    await page.locator('label[for="gender-radio-1"]').click();

    // Mobile number
    await page.locator('#userNumber').fill('9876543210');

    // Date of birth
    await page.locator('#dateOfBirthInput').click();
    await page.locator('.react-datepicker__year-select').selectOption('1995');
    await page.locator('.react-datepicker__month-select').selectOption('7'); // August (0-indexed)
    await page.locator('.react-datepicker__day--005:not(.react-datepicker__day--outside-month)').click();

    // Subjects (react-select typeahead) - click the rendered option rather than
    // pressing Enter, since Enter falls through to native form submit if the
    // dropdown hasn't rendered yet.
    await page.locator('#subjectsInput').fill('Maths');
    await page.locator('.subjects-auto-complete__option', { hasText: 'Maths' }).click();

    // Hobbies (checkbox input is visually hidden; click its label)
    await page.locator('label[for="hobbies-checkbox-2"]').click();

    // Picture upload
    await page.locator('#uploadPicture').setInputFiles(path.join(__dirname, 'fixtures', 'sample-avatar.png'));

    // Current address
    await page.locator('#currentAddress').fill('123 Test Street, Testville');

    // State
    await page.locator('#state').click();
    await page.getByText('NCR', { exact: true }).click();

    // City
    await page.locator('#city').click();
    await page.getByText('Delhi', { exact: true }).click();

    // Submit
    await page.locator('#submit').click();

    // Verify confirmation modal is visible
    const modalTitle = page.locator('#example-modal-sizes-title-lg');
    await expect(modalTitle).toBeVisible();
    await expect(modalTitle).toHaveText('Thanks for submitting the form');
  });
});
