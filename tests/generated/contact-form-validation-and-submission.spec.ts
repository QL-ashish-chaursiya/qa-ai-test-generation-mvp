// spec: Contact form displays correctly and accepts valid input
// scenario: Contact form validation and submission

import { test, expect } from '@playwright/test';

test.describe('Contact form displays correctly and accepts valid input', () => {
  test('Contact form validation and submission', async ({ page }) => {
    // 1. Navigate to https://clearvisit.app/contact in a fresh browser session
    await page.goto('https://clearvisit.app/contact');

    // Verify: Contact page loads successfully with page title 'ClearVisit'
    await expect(page).toHaveTitle('ClearVisit');

    // Verify: Page URL is https://clearvisit.app/contact
    await expect(page).toHaveURL('https://clearvisit.app/contact');

    // Verify: Heading 'Contact Us' is visible
    const contactHeading = page.getByRole('heading', { name: 'Contact Us', level: 1 });
    await expect(contactHeading).toBeVisible();

    // Verify: Subheading 'Let's start a conversation' is visible
    const subheading = page.getByRole('heading', { name: "Let's start a conversation", level: 2 });
    await expect(subheading).toBeVisible();

    // 2. Observe the contact form structure
    
    // Verify: Form contains input field labeled 'First Name' with placeholder 'John'
    const firstNameField = page.locator('input[placeholder="John"]');
    await expect(firstNameField).toBeVisible();

    // Verify: Form contains input field labeled 'Last Name' with placeholder 'Doe'
    const lastNameField = page.locator('input[placeholder="Doe"]');
    await expect(lastNameField).toBeVisible();

    // Verify: Form contains input field labeled 'Email' with placeholder 'john@example.com'
    const emailField = page.locator('input[placeholder="john@example.com"]');
    await expect(emailField).toBeVisible();

    // Verify: Form contains input field labeled 'Subject' with placeholder 'How can we help?'
    const subjectField = page.locator('input[placeholder="How can we help?"]');
    await expect(subjectField).toBeVisible();

    // Verify: Form contains textarea labeled 'Message' with placeholder 'Tell us more about your inquiry...'
    const messageField = page.locator('textarea[placeholder="Tell us more about your inquiry..."]');
    await expect(messageField).toBeVisible();

    // Verify: Form has a 'Send Message' button
    const sendButton = page.locator('button:has-text("Send Message")');
    await expect(sendButton).toBeVisible();

    // 3. Fill in the contact form with valid data
    
    // Fill First Name: John
    await page.locator('input[placeholder="John"]').fill('John');

    // Fill Last Name: Smith
    await page.locator('input[placeholder="Doe"]').fill('Smith');

    // Fill Email: john.smith@example.com
    await page.locator('input[placeholder="john@example.com"]').fill('john.smith@example.com');

    // Fill Subject: Question about HIPAA compliance
    await page.locator('input[placeholder="How can we help?"]').fill('Question about HIPAA compliance');

    // Fill Message: I would like to know more about how ClearVisit ensures HIPAA compliance.
    await page.locator('textarea[placeholder="Tell us more about your inquiry..."]').fill('I would like to know more about how ClearVisit ensures HIPAA compliance.');

    // Verify: All fields accept the entered text without errors
    // Verify: All entered values are visible in their respective fields
    await expect(page.locator('input[placeholder="John"]')).toHaveValue('John');
    await expect(page.locator('input[placeholder="Doe"]')).toHaveValue('Smith');
    await expect(page.locator('input[placeholder="john@example.com"]')).toHaveValue('john.smith@example.com');
    await expect(page.locator('input[placeholder="How can we help?"]')).toHaveValue('Question about HIPAA compliance');
    await expect(page.locator('textarea[placeholder="Tell us more about your inquiry..."]')).toHaveValue('I would like to know more about how ClearVisit ensures HIPAA compliance.');

    // 4. Click the 'Send Message' button
    await page.locator('button:has-text("Send Message")').click();

    // Verify: User receives feedback indicating message was sent (success message)
    const successHeading = page.getByRole('heading', { name: 'Message Sent!', level: 3 });
    await expect(successHeading).toBeVisible();

    const successMessage = page.getByText("We'll get back to you within 24 hours.");
    await expect(successMessage).toBeVisible();
  });
});
