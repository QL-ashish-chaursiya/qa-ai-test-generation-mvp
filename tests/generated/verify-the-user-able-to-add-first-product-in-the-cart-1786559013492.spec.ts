import { test, expect } from '@playwright/test';

test.describe('Add first product to cart', () => {
  test('user is able to add the first product in the cart', async ({ page }) => {
    await page.goto('http://localhost:8000/index.html');

    // Cart starts empty
    await expect(page.getByRole('link', { name: /^Cart/ })).toContainText('0');

    // Open the first product (Wireless Earbuds)
    await page.getByRole('link', { name: '🎧 Wireless Earbuds $59.99' }).click();
    await expect(page).toHaveURL(/product\.html\?id=1/);

    // Add it to the cart
    await page.getByRole('button', { name: 'Add to Cart' }).click();
    await expect(page.getByText('Added to cart!')).toBeVisible();

    // Cart badge reflects the addition
    await expect(page.getByRole('link', { name: /^Cart/ })).toContainText('1');

    // Cart page shows the added product
    await page.goto('http://localhost:8000/cart.html');
    await expect(page.getByText('Wireless Earbuds')).toBeVisible();
    await expect(page.getByText('Standard · qty 1')).toBeVisible();
  });
});
