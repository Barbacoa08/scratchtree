import { test, expect, type Page } from '@playwright/test';

const composer = (page: Page) =>
  page.getByRole('textbox', { name: 'New note Markdown' });
const stream = (page: Page) =>
  page.getByRole('region', { name: 'Note stream' });
const cards = (page: Page) => page.locator('.note-card');

async function capture(page: Page, source: string) {
  await composer(page).fill(source);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
}

test('a blank composer click focuses the editor and leaves the hint and Save control independent', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await composer(page).waitFor();
  await stream(page).focus();
  const box = (await page.locator('.composer .cm-editor').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.65);
  await expect(composer(page)).toBeFocused();
  await page.keyboard.insertText('Draft text');
  await stream(page).focus();
  await page.getByText('returns to notes').last().click();
  await expect(composer(page)).not.toBeFocused();
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(cards(page)).toHaveText(/Draft text/);
});

test('saved paragraphs show single line breaks, matched spacing, and keyboard disclosure', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await composer(page).waitFor();
  const source =
    'Line one\nLine two\n\nA paragraph\n\n- First item\n- Second item\n- Third item\n- Fourth item';
  await capture(page, source);
  const rendered = cards(page).locator('.markdown-view');
  await expect(rendered.locator('p').first().locator('br')).toHaveCount(1);
  await expect(rendered.locator('p').nth(1)).toHaveCSS(
    'margin-block-start',
    '10px',
  );
  await expect(rendered.locator('li').nth(1)).toHaveCSS(
    'margin-block-start',
    '10px',
  );
  await stream(page).focus();
  await expect(
    cards(page).getByRole('button', { name: 'Expand note' }),
  ).toBeVisible();
  await page.keyboard.press('v');
  await expect(
    cards(page).getByRole('button', { name: 'Collapse note' }),
  ).toBeVisible();
  await page.keyboard.press('v');
  await expect(
    cards(page).getByRole('button', { name: 'Expand note' }),
  ).toBeVisible();
  await composer(page).focus();
  await page.keyboard.press('v');
  await expect(composer(page)).toHaveText('v');
  await expect(
    cards(page).getByRole('button', { name: 'Expand note' }),
  ).toBeVisible();
});

test('confirmed sync with recovery keeps the composer clear and recovery available in Details', async ({
  page,
}) => {
  await page.setViewportSize({ width: 850, height: 650 });
  await page.goto('/?fixture&authFixture');
  await composer(page).waitFor();
  await capture(page, 'Saved note');
  await page.evaluate(() => {
    (window as any).authUiFixture.setSync({
      state: 'up-to-date',
      recoveries: 1,
      detail: 'Alternative input is retained in recovery.',
    });
  });
  await expect(page.locator('.workspace-feedback.compact')).toHaveClass(
    /sr-only/,
  );
  const details = page.getByRole('button', {
    name: 'Show Details',
    exact: true,
  });
  await expect(details).not.toHaveAccessibleDescription(
    'Recovery is available in Details.',
  );
  await expect(details.locator('.details-attention')).toHaveCount(0);
  await details.click();
  await page.getByRole('button', { name: 'Up to date', exact: true }).click();
  await expect(
    page.getByText('1 recovery item', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export recovery' }),
  ).toBeVisible();
});

test('focus returns to Details when routine compact sync status disappears', async ({
  page,
}) => {
  await page.setViewportSize({ width: 850, height: 650 });
  await page.goto('/?fixture&authFixture');
  await composer(page).waitFor();
  await page.evaluate(() => {
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      detail: 'Offline',
    });
  });
  const status = page.getByRole('button', { name: 'Needs sync', exact: true });
  await status.focus();
  await status.press('Enter');
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).authUiFixture.setSync({
      state: 'up-to-date',
      detail: null,
    });
  });
  await expect(status).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Show Details', exact: true }),
  ).toBeFocused();
});

test('an active recovery export can report its failure across sync confirmation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 850, height: 650 });
  await page.goto('/?fixture&authFixture');
  await composer(page).waitFor();
  await page.evaluate(() => {
    const fixture = (window as any).authUiFixture;
    fixture.delayRecovery();
    fixture.failRecovery(true);
    fixture.setSync({ state: 'needs-sync', recoveries: 1 });
  });
  await page.getByRole('button', { name: 'Needs sync', exact: true }).click();
  const recovery = page.getByRole('button', {
    name: 'Export recovery',
    exact: true,
  });
  await recovery.focus();
  await recovery.press('Enter');
  await expect(recovery).toBeDisabled();
  await page.evaluate(() => {
    (window as any).authUiFixture.setSync({ state: 'up-to-date' });
  });
  await expect(recovery).toBeDisabled();
  await page.evaluate(() => (window as any).authUiFixture.finishRecovery());
  await expect(page.getByText('Synthetic export failure')).toBeVisible();
  await expect(recovery).toBeEnabled();
  await page.evaluate(() => (window as any).authUiFixture.failRecovery(false));
  await recovery.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Show Details', exact: true }),
  ).toBeFocused();
});
