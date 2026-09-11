// spec: Homepage displays all key sections with correct content and layout
// Test: Navigate to homepage, verify all sections, and test navigation

import { test, expect } from '@playwright/test';

test.describe('Homepage displays all key sections with correct content and layout', () => {
  test('Navigate to https://clearvisit.app/ and verify all key sections', async ({ page }) => {
    // Navigate to https://clearvisit.app/
    await page.goto('https://clearvisit.app/');

    // Verify page loads successfully with title 'ClearVisit'
    expect(page.url()).toBe('https://clearvisit.app/');

    // Verify Hero section is visible with heading 'Understand every doctor visit, like never before.'
    await expect(page.getByRole('heading', { name: 'Understand every doctor visit' })).toBeVisible();

    // Verify Hero section displays App Store download button
    await expect(page.getByRole('link', { name: 'Download on the App Store' }).first()).toBeVisible();

    // Verify Hero section displays Google Play download button
    await expect(page.getByRole('link', { name: 'Get it on Google Play' }).first()).toBeVisible();

    // Verify Features section is visible with heading 'What We Offer'
    await expect(page.getByText('What We Offer')).toBeVisible();

    // Verify Features section displays AI-Powered Summaries card
    await expect(page.getByRole('heading', { name: 'AI-Powered Summaries' })).toBeVisible();

    // Verify Features section displays One-Tap Recording card
    await expect(page.getByRole('heading', { name: 'One-Tap Recording' })).toBeVisible();

    // Verify Features section displays HIPAA-Compliant Security card
    await expect(page.getByRole('heading', { name: 'HIPAA-Compliant Security' })).toBeVisible();

    // Verify Features section displays Share with Family card
    await expect(page.getByRole('heading', { name: 'Share with Family' })).toBeVisible();

    // Verify Features section displays Organized Health History card
    await expect(page.getByRole('heading', { name: 'Organized Health History' })).toBeVisible();

    // Verify Features section displays Follow Up Questions Generated card
    await expect(page.getByRole('heading', { name: 'Follow Up Questions Generated' })).toBeVisible();

    // Verify How It Works section is visible with heading 'Healthcare communication, finally made human.'
    await expect(page.getByRole('heading', { name: 'Healthcare communication,' })).toBeVisible();

    // Verify How It Works section displays first step: Be Present in the Moment
    await expect(page.getByRole('heading', { name: 'Be Present in the Moment' })).toBeVisible();

    // Verify How It Works section displays second step: Understand Your Care Plan
    await expect(page.getByRole('heading', { name: 'Understand Your Care Plan' })).toBeVisible();

    // Verify How It Works section displays third step: Reflect and Share with Confidence
    await expect(page.getByRole('heading', { name: 'Reflect and Share with' })).toBeVisible();

    // Verify Privacy Promise section is visible with heading 'Your health data, safe and private.'
    await expect(page.getByRole('heading', { name: 'Your health data, safe and' })).toBeVisible();

    // Verify Privacy Promise section displays 100% HIPAA Compliant card
    await expect(page.getByRole('heading', { name: '% HIPAA Compliant' })).toBeVisible();

    // Verify Privacy Promise section displays Bank-Grade Encryption card
    await expect(page.getByRole('heading', { name: 'Bank-Grade Encryption' })).toBeVisible();

    // Verify Privacy Promise section displays Your Data, Your Rules card
    await expect(page.getByRole('heading', { name: 'Your Data, Your Rules' })).toBeVisible();

    // Verify Privacy Promise section displays Enterprise Infrastructure card
    await expect(page.getByRole('heading', { name: 'Enterprise Infrastructure' })).toBeVisible();

    // Verify Navigation header is visible with ClearVisit logo
    await expect(page.getByRole('navigation').getByRole('link', { name: 'ClearVisit' })).toBeVisible();

    // Verify Navigation menu shows Features link
    await expect(page.getByRole('link', { name: 'Features' })).toBeVisible();

    // Verify Navigation menu shows How It Works link
    await expect(page.getByRole('link', { name: 'How It Works' })).toBeVisible();

    // Verify Navigation menu shows Privacy Policy link
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Privacy Policy' })).toBeVisible();

    // Verify Contact Us button is visible in the navigation
    await expect(page.getByRole('button', { name: 'Contact Us' })).toBeVisible();

    // Verify Footer is visible with copyright notice
    await expect(page.getByText('© 2026 ClearVisit. All rights')).toBeVisible();

    // Verify Footer contains Home link
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();

    // Verify Footer contains Contact link
    await expect(page.getByRole('link', { name: 'Contact Us', exact: true })).toBeVisible();

    // Verify Footer contains Privacy Policy link
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Privacy Policy' })).toBeVisible();

    // Verify Footer displays social media icons (LinkedIn, Instagram, Facebook)
    const linkedInIcon = page.locator('img[alt="linkedin"]');
    const instagramIcon = page.locator('img[alt="instagram"]');
    const facebookIcon = page.locator('img[alt="facebook"]');
    await expect(linkedInIcon).toBeVisible();
    await expect(instagramIcon).toBeVisible();
    await expect(facebookIcon).toBeVisible();

    // Click the ClearVisit logo in the navigation header
    await page.locator('nav a[href="/"]').click();

    // Verify user is navigated to https://clearvisit.app/
    expect(page.url()).toBe('https://clearvisit.app/');
  });
});
