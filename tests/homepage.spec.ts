// spec: specs/clearvisit-test-plan.md
// seed: seed.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Homepage Navigation', () => {
  test('Header nav links scroll to correct sections', async ({ page }) => {
    // 1. Navigate to /
    await page.goto('https://clearvisit.app/');

    // 2. Click "Features" in the header nav
    await page.getByRole('link', { name: 'Features', exact: true }).first().click();
    await expect(page).toHaveURL(/#features$/);

    // 3. Click "How It Works" in the header nav
    await page.getByRole('link', { name: 'How It Works', exact: true }).first().click();
    await expect(page).toHaveURL(/#how-it-works$/);

    // 4. Click "Privacy Policy" in the header nav
    await page.getByRole('link', { name: 'Privacy Policy', exact: true }).first().click();
    await expect(page).toHaveURL(/\/privacy-policy$/);

    // 5. Click "Contact Us" in the header nav
    await page.goto('https://clearvisit.app/');
    await page.getByRole('link', { name: 'Contact Us', exact: true }).first().click();
    await expect(page).toHaveURL(/\/contact$/);
  });

  test('Logo returns to home', async ({ page }) => {
    // 1. Navigate to /contact
    await page.goto('https://clearvisit.app/contact');

    // 2. Click the "ClearVisit" logo/wordmark in the header
    await page.getByRole('link', { name: 'ClearVisit', exact: true }).first().click();
    await expect(page).toHaveURL('https://clearvisit.app/');
  });

  test('App store badges link out correctly', async ({ page }) => {
    // 1. Navigate to /
    await page.goto('https://clearvisit.app/');

    // 2. Locate the "Download on the App Store" badge and verify its href
    const appStore = page.locator('a[href*="apps.apple.com"]').first();
    await expect(appStore).toHaveAttribute('href', 'https://apps.apple.com/in/app/clearvisit/id6752611256');
    await expect(appStore).toHaveAttribute('target', '_blank');

    // 3. Locate the "Get it on Google Play" badge and verify its href
    const googlePlay = page.locator('a[href*="play.google.com"]').first();
    await expect(googlePlay).toHaveAttribute('href', /play\.google\.com\/store\/apps\/details\?id=com\.clearvisit\.prod/);
    await expect(googlePlay).toHaveAttribute('target', '_blank');
  });

  test('Key marketing content is present', async ({ page }) => {
    // 1. Navigate to /
    await page.goto('https://clearvisit.app/');

    // 2. Verify hero heading is visible
    await expect(page.getByRole('heading', { name: 'Understand every doctor visit, like never before.' })).toBeVisible();

    // 3. Verify all six feature cards are visible
    for (const feature of [
      'AI-Powered Summaries',
      'One-Tap Recording',
      'HIPAA-Compliant Security',
      'Share with Family',
      'Organized Health History',
      'Follow Up Questions Generated',
    ]) {
      await expect(page.getByRole('heading', { name: feature })).toBeVisible();
    }

    // 4. Verify the 3-step "experience" flow is visible
    for (const step of ['Be Present in the Moment', 'Understand Your Care Plan', 'Reflect and Share with Confidence']) {
      await expect(page.getByRole('heading', { name: step })).toBeVisible();
    }

    // 5. Verify security claims are visible
    for (const claim of ['100% HIPAA Compliant', 'Bank-Grade Encryption', 'Your Data, Your Rules', 'Enterprise Infrastructure']) {
      await expect(page.getByRole('heading', { name: claim })).toBeVisible();
    }
  });

  test('Footer links and socials', async ({ page }) => {
    // 1. Navigate to /, scroll to footer
    await page.goto('https://clearvisit.app/');
    const footer = page.locator('footer');
    await footer.scrollIntoViewIfNeeded();

    // 2. Click "Home" footer link
    await footer.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page).toHaveURL('https://clearvisit.app/');

    // 3. Click "Contact" footer link
    await page.locator('footer').getByRole('link', { name: 'Contact', exact: true }).click();
    await expect(page).toHaveURL(/\/contact$/);

    // 4. Click "Privacy Policy" footer link
    await page.locator('footer').getByRole('link', { name: 'Privacy Policy', exact: true }).click();
    await expect(page).toHaveURL(/\/privacy-policy$/);

    // 5. Verify social icon links
    await page.goto('https://clearvisit.app/');
    const linkedin = page.locator('footer a[href*="linkedin.com"]');
    const instagram = page.locator('footer a[href*="instagram.com"]');
    const facebook = page.locator('footer a[href*="facebook.com"]');
    await expect(linkedin).toHaveAttribute('target', '_blank');
    await expect(instagram).toHaveAttribute('target', '_blank');
    await expect(facebook).toHaveAttribute('target', '_blank');
  });
});
