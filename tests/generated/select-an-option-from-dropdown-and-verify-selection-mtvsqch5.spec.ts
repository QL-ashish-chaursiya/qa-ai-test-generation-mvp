import { test, expect } from '@playwright/test';

test.describe('Dropdown Selection Tests', () => {
  test('Select Option 1 from dropdown and verify it remains selected', async ({ page }) => {
    // Navigate to the dropdown page
    await page.goto('https://the-internet.herokuapp.com/dropdown');

    // Get the dropdown select element
    const dropdown = page.locator('#dropdown');

    // Verify the dropdown is visible
    await expect(dropdown).toBeVisible();

    // Click the dropdown to focus it
    await dropdown.click();

    // Select 'Option 1' from the dropdown using keyboard
    await dropdown.selectOption({ value: '1' });

    // Verify that 'Option 1' is now selected
    await expect(dropdown).toHaveValue('1');

    // Additional verification: check the selected option text
    const selectedOptionText = await dropdown.evaluate((el: HTMLSelectElement) => {
      return el.options[el.selectedIndex].text;
    });

    expect(selectedOptionText).toBe('Option 1');
  });
});
