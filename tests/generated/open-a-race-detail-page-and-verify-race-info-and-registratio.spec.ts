import { test, expect } from '@playwright/test';

const RACE_NAME = 'Dummy Race';
const API_BASE = 'https://qa-apis.runtheday.com/api/v2';

// The race is held in Noida (Asia/Calcutta). Running the browser in a far-away zone
// means a start time rendered in the viewer's clock would read 11:00 AM instead of
// 11:30 PM, so the date/time assertions below actually prove the race's own zone is used.
test.use({ timezoneId: 'America/Los_Angeles' });

// Non-breaking / narrow spaces creep into both Intl output and the rendered markup.
const normalize = (value: string) => value.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();

function formatInZone(instant: string, timeZone: string) {
  const date = new Date(instant);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;

  return {
    date: `${part('weekday')} ${part('month')}/${part('day')}/${part('year')}`,
    time: normalize(
      new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(date),
    ),
  };
}

test.describe('Race detail page', () => {
  test('opening a race card from Find a Run shows its details, open registration types and both CTAs', async ({ page, request }) => {
    // Two page loads plus a debounced search - the default 30s budget is tight
    test.setTimeout(120000);

    await page.goto('https://qa.runtheday.com/find-a-race/');

    const raceCard = page.locator('div.cursor-pointer.bg-primary-black-800');
    await expect(page.getByRole('heading', { name: 'Upcoming Races' })).toBeVisible();
    await expect(raceCard.first()).toBeVisible({ timeout: 30000 });

    // Narrow the listing down to the race under test - the search is debounced
    await page.getByTestId('search-event-field').fill(RACE_NAME);
    await expect(async () => {
      await expect(raceCard).toHaveCount(1);
      await expect(raceCard).toContainText(RACE_NAME);
    }).toPass({ timeout: 20000 });

    // Remember what the listing card advertises, so the detail page can be checked against it
    const listedDistances = (await raceCard.locator('p.bg-primary-black-500').allInnerTexts()).map(t => t.trim().toLowerCase());
    expect(listedDistances.length).toBeGreaterThan(0);
    const listedDate = (await raceCard.locator('p').filter({ hasText: /^\d{2}\/\d{2}\/\d{4}$/ }).innerText()).trim();

    // Open the race detail page by clicking the card (not its Register / Donate shortcuts)
    await raceCard.getByText(RACE_NAME, { exact: true }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/register\/detail\/[^/]+\//, { timeout: 30000 });

    // Race name
    await expect(page.getByRole('heading', { name: RACE_NAME, level: 1 })).toBeVisible({ timeout: 30000 });

    const slug = new URL(page.url()).pathname.split('/').filter(Boolean).pop()!;
    const raceResponse = await request.get(`${API_BASE}/race-details/${slug}?ref=direct`);
    expect(raceResponse.ok()).toBeTruthy();
    const race = (await raceResponse.json()).data;
    expect(race.title).toBe(RACE_NAME);

    // Event distances - every distance the race offers, matching the listing card's chips
    const distances = page
      .getByRole('heading', { name: RACE_NAME, level: 1 })
      .locator('xpath=following-sibling::p[1]');
    await expect(distances).toBeVisible();
    const shownDistances = normalize(await distances.innerText())
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(Boolean);
    expect(shownDistances).toEqual(race.events.map((e: { name: string }) => e.name.toLowerCase()));
    expect(shownDistances).toEqual(listedDistances);

    // Date and start time, stated in the race's own time zone rather than the viewer's
    // "WHEN ?" is wrapped in a span, so anchor on its paragraph and step up to the block
    const whenBlock = page.locator('p').filter({ hasText: /^WHEN \?$/ }).locator('xpath=..');
    await expect(whenBlock).toBeVisible();
    const expectedLocal = formatInZone(race.date_time, race.time_zone);
    const viewerLocal = formatInZone(race.date_time, 'America/Los_Angeles');
    // Guard: the two zones must disagree, otherwise the check below proves nothing
    expect(expectedLocal.time).not.toBe(viewerLocal.time);

    const shownDate = normalize(await whenBlock.locator('p').filter({ hasText: /^\w+day \d{2}\/\d{2}\/\d{4}$/ }).innerText());
    const shownTime = normalize(await whenBlock.locator('p').filter({ hasText: /^At \d{1,2}:\d{2}/ }).innerText());
    expect({ date: shownDate, time: shownTime }).toEqual({
      date: expectedLocal.date,
      time: `At ${expectedLocal.time}`,
    });
    expect(shownDate).toContain(listedDate);

    // About the race, with its route map link
    await expect(page.getByText('About The Race', { exact: true })).toBeVisible();
    const about = page.getByText('About The Race', { exact: true }).locator('xpath=following-sibling::div[1]');
    expect(normalize(await about.innerText())).toBe(normalize(race.description));
    const routeMap = page.getByRole('link', { name: 'ROUTE MAP' });
    await expect(routeMap).toBeVisible();
    await expect(routeMap).toHaveAttribute('href', race.route_map_url);

    // The four race tabs, with Race Info selected on arrival
    for (const tab of ['Race Info', 'Participants', 'Donations', 'Teams'])
      await expect(page.getByTestId(`${tab}-tab`)).toBeVisible();
    await expect(page.getByTestId('Race Info-tab')).toHaveAttribute('aria-selected', 'true');

    // Registration types that are currently open, each with its price
    await expect(page.getByText('Registrations', { exact: true })).toBeVisible();
    const registrationCard = page.locator('div.cursor-pointer.bg-primary-black-500');
    const openTypes: Array<{ name: string; price: number }> = race.registration_type.activeTypes.map(
      (t: { custom_name?: string; name: string; price: number }) => ({ name: t.custom_name || t.name, price: t.price }),
    );
    expect(openTypes.length).toBeGreaterThan(0);
    await expect(registrationCard).toHaveCount(openTypes.length);

    for (const [index, type] of openTypes.entries()) {
      const card = registrationCard.nth(index);
      await expect(card.getByText('OPEN', { exact: true })).toBeVisible();
      await expect(card.getByText(type.name, { exact: true })).toBeVisible();
      const price = card.locator('p').filter({ hasText: /^\$/ });
      await expect(price).toBeVisible();
      expect(normalize(await price.innerText())).toBe(`$ ${type.price}`);
    }

    // Both calls to action
    await expect(page.getByTestId('register-button')).toBeVisible();
    await expect(page.getByTestId('register-button')).toBeEnabled();
    await expect(page.getByTestId('donate-button')).toBeVisible();
    await expect(page.getByTestId('donate-button')).toBeEnabled();
  });
});
