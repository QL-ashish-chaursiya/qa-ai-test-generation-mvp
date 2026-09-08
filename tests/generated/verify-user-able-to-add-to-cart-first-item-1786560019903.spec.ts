import { test, expect } from '@playwright/test';

test.describe('Add to cart', () => {
  test('user is able to add the first item to the cart', async ({ page }) => {
    await page.goto('http://localhost:8000/index.html');

    // The cart badge starts empty
    await expect(page.getByRole('link', { name: /^Cart/ })).toContainText('0');

    // Open the first product on the listing page
    await page.getByRole('link', { name: '🎧 Wireless Earbuds $59.99' }).click();
    await expect(page).toHaveURL(/product\.html\?id=1/);

    // Add it to the cart from the product page
    await page.getByRole('button', { name: 'Add to Cart' }).click();
    await expect(page.getByText('Added to cart!')).toBeVisible();
    await expect(page.getByRole('link', { name: /^Cart/ })).toContainText('1');

    // Verify the cart page reflects the added item
    await page.goto('http://localhost:8000/cart.html');
    await expect(page.getByText('Wireless Earbuds')).toBeVisible();
    await expect(page.getByText('Standard · qty 1')).toBeVisible();
  });
});
