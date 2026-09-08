# Test Plan: ClearVisit (https://clearvisit.app/)

**Seed:** `seed.spec.ts`

Site under test is a marketing/landing page for the ClearVisit mobile app (AI-powered
doctor-visit summaries). There is no in-page signup/login — conversion happens via
App Store / Google Play links. The only interactive form on the site is on `/contact`.

Pages discovered:
- `/` — home / landing page
- `/contact` — contact form
- `/privacy-policy` — static privacy policy

---

### 1. Homepage Navigation

#### 1.1 Header nav links scroll to correct sections
**Steps:**
1. Navigate to `/`
2. Click "Features" in the header nav
3. Click "How It Works" in the header nav
4. Click "Privacy Policy" in the header nav
5. Click "Contact Us" in the header nav

**Expected:**
- "Features" and "How It Works" scroll the page to their respective in-page anchors (`#features`, `#how-it-works`) without a full navigation/reload
- "Privacy Policy" navigates to `/privacy-policy`
- "Contact Us" navigates to `/contact`

#### 1.2 Logo returns to home
**Steps:**
1. Navigate to `/contact`
2. Click the "ClearVisit" logo/wordmark in the header

**Expected:** Browser navigates back to `/`

#### 1.3 App store badges link out correctly
**Steps:**
1. Navigate to `/`
2. Locate the "Download on the App Store" badge and verify its `href`
3. Locate the "Get it on Google Play" badge and verify its `href`

**Expected:**
- App Store badge points to `https://apps.apple.com/in/app/clearvisit/id6752611256`
- Google Play badge points to `https://play.google.com/store/apps/details?id=com.clearvisit.prod&hl=en_IN`
- (Do not actually follow external store links in CI — assert `href`/`target` only)

#### 1.4 Key marketing content is present
**Steps:**
1. Navigate to `/`
2. Verify hero heading "Understand every doctor visit, like never before." is visible
3. Scroll to the features section and verify all six feature cards are visible: AI-Powered Summaries, One-Tap Recording, HIPAA-Compliant Security, Share with Family, Organized Health History, Follow Up Questions Generated
4. Scroll to "THE EXPERIENCE" section and verify the 3-step flow is visible: "Be Present in the Moment", "Understand Your Care Plan", "Reflect and Share with Confidence"
5. Scroll to "OUR PROMISE" section and verify security claims are visible: "100% HIPAA Compliant", "Bank-Grade Encryption", "Your Data, Your Rules", "Enterprise Infrastructure"

**Expected:** All listed headings/sections render without errors; no layout overlap; no console errors.

#### 1.5 Footer links and socials
**Steps:**
1. Navigate to `/`, scroll to footer
2. Click "Home" footer link
3. Return to `/`, click "Contact" footer link
4. Return to `/`, click "Privacy Policy" footer link
5. Verify LinkedIn, Instagram, Facebook icon links have correct `href`s and open in a new tab

**Expected:** Each link navigates to the correct page; social icons open `linkedin.com/company/clearvisit`, `instagram.com/clearvisit`, `facebook.com/p/ClearVisit-...` respectively in a new tab.

---

### 2. Contact Form (`/contact`)

Form fields observed: First name (text), Last name (text), Email (email), Subject (text,
placeholder "How can we help?"), Message (textarea), submit button "Send Message".
No fields currently render as HTML `required`, so client-side validation behavior must be
discovered empirically by the generator/healer at run time.

#### 2.1 Submit contact form with valid data (happy path)
**Steps:**
1. Navigate to `/contact`
2. Fill First name with "Jane"
3. Fill Last name with "Doe"
4. Fill Email with "jane.doe@example.com"
5. Fill Subject with "General question"
6. Fill Message with "This is a test message from an automated test."
7. Click "Send Message"

**Expected:** Form submits successfully — success confirmation (toast/message/redirect) is shown, and no console errors occur. (Exact success UI to be confirmed by generator during live run.)

#### 2.2 Submit with empty required fields
**Steps:**
1. Navigate to `/contact`
2. Leave all fields empty
3. Click "Send Message"

**Expected:** Submission is blocked and validation feedback is shown for missing fields (or, if the backend rejects it, an inline/toast error is shown). Assert no message is actually sent (network request not fired, or fired with a 4xx).

#### 2.3 Invalid email format is rejected
**Steps:**
1. Navigate to `/contact`
2. Fill all fields with valid data except Email = "not-an-email"
3. Click "Send Message"

**Expected:** Form shows an email-format validation error and does not submit.

#### 2.4 Long input / boundary values
**Steps:**
1. Navigate to `/contact`
2. Fill Message with a very long string (~5000 characters)
3. Fill remaining fields with valid data
4. Click "Send Message"

**Expected:** Either the form accepts and submits the long message, or shows a clear max-length validation error — it must not crash the page or silently truncate without feedback.

#### 2.5 Special characters / basic XSS-safe input
**Steps:**
1. Navigate to `/contact`
2. Fill Subject with `<script>alert(1)</script>` and Message with `Test & "quotes" 'apostrophes' <b>bold</b>`
3. Fill remaining fields with valid data
4. Click "Send Message"

**Expected:** Input is accepted as literal text (submitted safely or validated), no script executes, and no unescaped HTML is rendered back on the page.

---

### 3. Privacy Policy Page

#### 3.1 Privacy policy loads and is readable
**Steps:**
1. Navigate to `/privacy-policy`

**Expected:** Page loads with a heading and policy body text; no console errors; no broken layout.

---

### 4. Cross-cutting / Non-functional Smoke Checks

#### 4.1 No console errors across pages
**Steps:**
1. Navigate to `/`, `/contact`, `/privacy-policy` in turn

**Expected:** No `console.error` or uncaught page errors on any of the three pages.

#### 4.2 Direct deep-link navigation
**Steps:**
1. Navigate directly to `/contact` (not via in-app link)
2. Navigate directly to `/privacy-policy` (not via in-app link)

**Expected:** Both pages load correctly on a cold/direct hit (no client-side-routing-only 404).
