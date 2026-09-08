# Test Plan: Submitree Sign In (https://dev-submitree-fe.qkkalabs.com/auth/signin/)

**Seed:** `seed.spec.ts`

Scope: **happy-path scenarios only** — every scenario assumes normal, successful user
behavior and each includes an explicit assertion. No negative/validation-error cases
are included per request.

Page elements discovered:
- Heading "Welcome back", subtext "Access your events and submissions."
- Role selector (radio group): Participant (default selected), Reviewer, Organizer, Others
- Email input — `input[name="email"]`, placeholder "Username@domain.com"
- Password input — `input[name="password"]`, placeholder "Enter password", with a
  show/hide (eye icon) toggle
- "Sign In" submit button — visually disabled until the form has valid input
- Link "Reset it here." → `/auth/forgot-password/`
- Link "Create an account." → `/auth/signup/`

---

### 1. Page Load

#### 1.1 Sign-in page loads with all expected elements
**Steps:**
1. Navigate to `/auth/signin/`

**Expected:** Heading "Welcome back" is visible; role options (Participant, Reviewer,
Organizer, Others) are visible; Email and Password inputs are visible; "Sign In" button
is visible; "Reset it here." and "Create an account." links are visible.

---

### 2. Role Selection

#### 2.1 Participant is selected by default
**Steps:**
1. Navigate to `/auth/signin/`

**Expected:** The "Participant" role option is selected/checked by default.

#### 2.2 Selecting a different role updates the selection
**Steps:**
1. Navigate to `/auth/signin/`
2. Click "Reviewer"
3. Click "Organizer"
4. Click "Others"

**Expected:** After each click, the clicked role becomes the selected option and the
previously selected option becomes unselected (only one role selected at a time).

---

### 3. Password Visibility Toggle

#### 3.1 Toggling the eye icon reveals and hides the password
**Steps:**
1. Navigate to `/auth/signin/`
2. Fill Password with "SomeValue123"
3. Click the show/hide (eye) icon inside the password field
4. Click the show/hide (eye) icon again

**Expected:** After step 3, the password input's `type` attribute changes from
`password` to `text` (value visible as plain text). After step 4, it reverts to `type="password"`.

---

### 4. Form Enablement

#### 4.1 Sign In button becomes enabled once valid input is provided
**Steps:**
1. Navigate to `/auth/signin/`
2. Fill Email with "testuser@example.com"
3. Fill Password with "ValidPassword123"

**Expected:** The "Sign In" button transitions from disabled to enabled (clickable) once both fields hold valid-format values.

---

### 5. Successful Sign In

#### 5.1 Signing in with valid credentials logs the user in
**Steps:**
1. Navigate to `/auth/signin/`
2. Select the appropriate role for the test account
3. Fill Email with a valid, registered account email
4. Fill Password with that account's correct password
5. Click "Sign In"

**Expected:** The app navigates away from `/auth/signin/` to an authenticated
area/dashboard, and a signed-in indicator (e.g. user menu, dashboard heading, or
welcome text with the account's name) is visible.

> **Needs test credentials.** This scenario requires a real, valid account (email +
> password, per role) on the `dev-submitree-fe.qkkalabs.com` environment. I don't have
> one, so I can plan this scenario but can't generate a runnable/passing test for it
> without credentials you provide.

---

### 6. Navigation Links

#### 6.1 "Reset it here." navigates to Forgot Password
**Steps:**
1. Navigate to `/auth/signin/`
2. Click "Reset it here."

**Expected:** Browser navigates to `/auth/forgot-password/` and that page renders (e.g. a password-reset heading/form is visible).

#### 6.2 "Create an account." navigates to Sign Up
**Steps:**
1. Navigate to `/auth/signin/`
2. Click "Create an account."

**Expected:** Browser navigates to `/auth/signup/` and that page renders (e.g. a sign-up heading/form is visible).
