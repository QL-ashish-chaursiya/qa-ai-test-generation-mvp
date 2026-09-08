import { test, expect } from '@playwright/test';

test.describe('add-to-cart', () => {
  test('adds Coffee Subscription (product id=4) to cart after selecting a plan', async ({ page }) => {
    // 1. open-product: navigate and note baseline cart count
    await page.goto('http://localhost:8000/product.html?id=4');
    const cartLink = page.getByRole('link', { name: /Cart/ });
    await expect(cartLink).toContainText('0');

    // 2. configure-product: page requires a plan selection before Add to Cart is enabled
    const addToCartButton = page.getByRole('button', { name: 'Add to Cart' });
    await expect(addToCartButton).toBeDisabled();
    await page.getByRole('radio', { name: 'Monthly bag' }).click();
    await expect(page.getByRole('radio', { name: 'Monthly bag' })).toBeChecked();

    // Quantity stepper defaults to 1, no change needed.

    // 3. add-to-cart: click once enabled
    await expect(addToCartButton).toBeEnabled();
    await addToCartButton.click();

    // 4. verify-confirmation: inline message shown and cart count incremented by exactly 1
    await expect(page.getByText('Added to cart!')).toBeVisible();
    await expect(cartLink).toContainText('1');
  });
});
