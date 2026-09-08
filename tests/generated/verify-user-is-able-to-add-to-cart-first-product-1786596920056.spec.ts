import { test, expect } from '@playwright/test';

test.describe('Add to cart', () => {
  test('user is able to add to cart first product', async ({ page }) => {
    await page.goto('http://localhost:8000/index.html');

    // Cart starts empty
    await expect(page.getByRole('link', { name: /^Cart/ })).toContainText('0');

    // Open the first product on the listing page
    await page.getByRole('link', { name: '👕 Classic Cotton T-Shirt $24.99' }).click();
    await expect(page).toHaveURL(/product\.html\?id=2/);

    // Select required options and add the product to the cart
    await page.getByLabel('Size').selectOption('Medium');
    await page.getByLabel('Color').selectOption('Black');
    await page.getByRole('button', { name: 'Add to Cart' }).click();

    // Confirm success feedback and updated cart badge
    await expect(page.getByText('Added to cart!')).toBeVisible();
    await expect(page.getByRole('link', { name: /^Cart/ })).toContainText('1');

    // Verify the cart page reflects the added product
    await page.goto('http://localhost:8000/cart.html');
    await expect(page.getByText('Classic Cotton T-Shirt')).toBeVisible();
    await expect(page.getByText('Medium / Black · qty 1')).toBeVisible();
  });
});
