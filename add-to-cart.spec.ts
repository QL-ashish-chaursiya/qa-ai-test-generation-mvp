import { test, expect } from '@playwright/test';

test.describe('add-to-cart', () => {
  test('adds a configured product (Running Shoes) to the cart', async ({ page }) => {
    // 1. open-product: navigate and note baseline cart count
    await page.goto('http://localhost:8000/product.html?id=3');
    const cartLink = page.getByRole('link', { name: /Cart/ });
    await expect(cartLink).toContainText('0');

    // 2. configure-product: page requires Size and Color selection before Add to Cart is enabled
    const addToCartButton = page.getByRole('button', { name: 'Add to Cart' });
    await expect(addToCartButton).toBeDisabled();
    await page.getByRole('button', { name: '9', exact: true }).click();
    await page.getByRole('button', { name: 'Crimson' }).click();
    await expect(addToCartButton).toBeEnabled();

    // 3. add-to-cart: click the now-enabled Add to Cart control
    await addToCartButton.click();

    // 4. verify-confirmation: inline confirmation message shown and cart count incremented by 1
    await expect(page.getByText('Added to cart!')).toBeVisible();
    await expect(cartLink).toContainText('1');
  });
});
