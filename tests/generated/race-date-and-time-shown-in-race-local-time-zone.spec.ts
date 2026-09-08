import { test, expect } from '@playwright/test';

const RACE_NAME = 'Automation Test Race 2026';
const RACE_SLUG = 'automation-test-race-2026';

// Run the browser in a zone 9h30m ahead of the race's own zone (America/New_York).
// If any surface rendered the start time in the viewer's local time instead of the
// race's time zone, it would show 5:30 PM rather than 8:00 AM and this test would fail.
test.use({ timezoneId: 'Asia/Kolkata' });

test.describe('Race start date and time in the race time zone', () => {
  test('the race start date/time matches across the RD race list, the race preview page and the public race detail page', async ({ page }) => {
    // The RD race list is behind authentication, so sign in as the race director first
    await page.goto('https://qa.runtheday.com/account/login/');
    await page.getByTestId('email-field').fill('ashishrandom@yopmail.com');
    await page.getByTestId('continue-button').click();
    await page.getByTestId('password-field').fill('Ashish@123');
    await page.getByTestId('continue-button').click();

    // 1) RD race list - the card shows the start date plus the time with its zone label
    await expect(page).toHaveURL(/\/races\//, { timeout: 30000 });
    const listCard = page.locator('div.cursor-pointer.bg-primary-black-500').filter({ hasText: RACE_NAME });
    await expect(listCard).toHaveCount(1, { timeout: 15000 });
    // The app redirects to its default race once hydrated - wait for that before selecting ours
    await expect(page.getByText('Race start date & time', { exact: true })).toBeVisible({ timeout: 15000 });

    const listDate = (await listCard.locator('p', { hasText: /^\d{2}\/\d{2}\/\d{4}$/ }).innerText()).trim();
    const listTimeWithZone = (await listCard.locator('p', { hasText: /^\d{1,2}:\d{2} (AM|PM) \S+\/\S+$/ }).innerText()).trim();

    const listMatch = listTimeWithZone.match(/^(\d{1,2}:\d{2} (?:AM|PM)) (\S+)$/);
    expect(listMatch, `race list time "${listTimeWithZone}" should be "<time> <IANA zone>"`).not.toBeNull();
    const [, listTime, listZone] = listMatch!;

    // The list states the race's own time zone rather than the viewer's
    // (the card is styled uppercase, so compare the IANA name case-insensitively)
    expect(listZone.toLowerCase()).toBe('america/new_york');

    // 2) Race preview page - opened by selecting the race in the list
    await listCard.click();
    await expect(page).toHaveURL(/\/races\/[0-9a-f]{24}\//, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: RACE_NAME, level: 5 })).toBeVisible({ timeout: 15000 });

    const previewStart = page.getByText('Race start date & time', { exact: true }).locator('xpath=following-sibling::h5[1]');
    const previewText = (await previewStart.innerText()).trim();

    const previewMatch = previewText.match(/^(\w+day) (\d{2}\/\d{2}\/\d{4}) (\d{1,2}:\d{2} (?:AM|PM))$/);
    expect(previewMatch, `preview start "${previewText}" should be "<weekday> <date> <time>"`).not.toBeNull();
    const [, weekday, previewDate, previewTime] = previewMatch!;

    // The preview repeats the same wall-clock date/time as the list
    expect({ date: previewDate, time: previewTime }).toEqual({ date: listDate, time: listTime });

    // 3) Public race detail page
    await page.goto(`https://qa.runtheday.com/register/detail/${RACE_SLUG}/`);
    const whenBlock = page.getByText('WHEN ?', { exact: true }).locator('xpath=..');
    await expect(whenBlock).toBeVisible({ timeout: 15000 });

    const publicDate = (await whenBlock.locator('p', { hasText: /^\w+day \d{2}\/\d{2}\/\d{4}$/ }).innerText()).trim();
    const publicTime = (await whenBlock.locator('p', { hasText: /^At \d{1,2}:\d{2} (AM|PM)$/ }).innerText()).trim();

    // The public page shows the identical start date/time - unshifted by the viewer's Asia/Kolkata clock
    expect({ date: publicDate, time: publicTime }).toEqual({
      date: `${weekday} ${listDate}`,
      time: `At ${listTime}`,
    });
  });
});
