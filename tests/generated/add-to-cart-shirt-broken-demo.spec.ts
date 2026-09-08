import { test, expect } from '@playwright/test';

test.describe('add-to-cart', () => {
  test('adds a single configured product to the cart', async ({ page }) => {
    // 1. open-product: navigate and note baseline cart count
    await page.goto('http://localhost:8000/product.html?id=2');
    const cartLink = page.getByRole('link', { name: /Cart/ });
    await expect(cartLink).toContainText('0');

    // 2. configure-product: required Size and Color dropdowns must be set
    await page.getByLabel('Size').selectOption('Medium');
    await page.getByLabel('Color').selectOption('Black');

    // 3. add-to-cart: click once enabled
    const addToCartButton = page.getByRole('button', { name: 'Add to Cart' });
    await expect(addToCartButton).toBeEnabled();
    await addToCartButton.click();

    // 4. verify-confirmation: inline message shown and cart count incremented by 1
    await expect(page.getByText('Added to cart!')).toBeVisible();
    await expect(cartLink).toContainText('1');
  });
});
