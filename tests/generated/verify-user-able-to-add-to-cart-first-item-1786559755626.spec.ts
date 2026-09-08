import { test, expect } from '@playwright/test';

test.describe('Add to cart', () => {
  test('user is able to add the first item to the cart', async ({ page }) => {
    await page.goto('http://localhost:8000/index.html');

    const firstProduct = page.locator('a.product-card').first();
    const productName = await firstProduct.locator('h3').innerText();
    await firstProduct.click();

    await expect(page).toHaveURL(/product\.html\?id=1/);

    await page.getByRole('button', { name: 'Add to Cart' }).click();

    await expect(page.getByText('Added to cart!')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cart 1' })).toBeVisible();

    await page.getByRole('link', { name: 'Cart 1' }).click();
    await expect(page).toHaveURL(/cart\.html/);
    await expect(page.getByText(productName, { exact: true })).toBeVisible();
  });
});
