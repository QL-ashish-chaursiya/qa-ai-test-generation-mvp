import { test, expect } from '@playwright/test';

test.describe('ad-hoc', () => {
  test('ensure complete checkout functionality is working', async ({ page }) => {
    // Navigate to the shop home page
    await page.goto('http://localhost:8000/index.html');

    // Open a product that requires selecting options via dropdowns
    await page.getByRole('link', { name: '👕 Classic Cotton T-Shirt $24' }).click();
    await expect(page).toHaveURL('http://localhost:8000/product.html?id=2');

    // Select required Size and Color options before Add to Cart is enabled
    await page.getByLabel('Size').selectOption(['Medium']);
    await page.getByLabel('Color').selectOption(['Black']);

    // Add the configured product to the cart
    await page.getByRole('button', { name: 'Add to Cart' }).click();
    await expect(page.getByText('Added to cart!')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cart 1' })).toBeVisible();

    // Go to the cart and verify the item and total are correct
    await page.getByRole('link', { name: 'Cart' }).click();
    await expect(page).toHaveURL('http://localhost:8000/cart.html');
    await expect(page.getByText('Classic Cotton T-Shirt')).toBeVisible();
    await expect(page.getByText('Medium / Black · qty 1')).toBeVisible();
    await expect(page.getByText('$24.99')).toBeVisible();

    // Proceed to checkout
    await page.getByRole('link', { name: 'Checkout' }).click();
    await expect(page).toHaveURL('http://localhost:8000/checkout.html');

    // Fill in required checkout form fields
    await page.getByRole('textbox', { name: 'Full name' }).fill('Ashish Chaurasiya');
    await page.getByRole('textbox', { name: 'Email' }).fill('chaurasiyaashish383@gmail.com');
    await page.getByRole('textbox', { name: 'Shipping address' }).fill('123 Main Street, Springfield, IL 62704');

    // Place the order
    await page.getByRole('button', { name: 'Place Order' }).click();

    // Verify order confirmation and that the cart was cleared
    await expect(page.getByRole('heading', { name: 'Order placed!' })).toBeVisible();
    await expect(page.getByText(/Your order number is/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cart 0' })).toBeVisible();
  });
});
