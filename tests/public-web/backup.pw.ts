import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { BackupV8 } from '../../src/lib/sync/backup';

test('restore and offline backup preserve the exact portable library', async ({
  page,
}) => {
  const path = 'tests/fixtures/valid-v8.json';
  const original = JSON.parse(await readFile(path, 'utf8')) as BackupV8;
  const yesterday = Date.now() - 86_400_000;
  for (const item of original.library.items) {
    item.createdAt += yesterday;
    item.updatedAt += yesterday;
    if (item.deletedAt !== null) item.deletedAt += yesterday;
  }
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: 'recent-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(original)),
  });
  await expect(
    page.getByText('This replaces the notes in this browser.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Replace library', exact: true })
    .click();
  await expect(
    page.getByText('Library restored', { exact: true }),
  ).toBeAttached();

  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Download previous notes' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Export backup' }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download backup' }).click();
  const download = await pending;
  const restored = JSON.parse(
    await readFile((await download.path())!, 'utf8'),
  ) as BackupV8;
  expect(restored.library).toEqual(original.library);
  expect(restored.device.drafts).toEqual(
    expect.arrayContaining(original.device.drafts),
  );
  expect(restored.device.undoDeleteIds).toEqual(original.device.undoDeleteIds);
});

test('restore preview shows the retention policy before replacing old Trash', async ({
  page,
}) => {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await (await chooser).setFiles('tests/fixtures/valid-v8.json');
  const preview = page.getByRole('region', { name: 'Replace library?' });
  await expect(
    preview.getByText(/Imported Trash older than 180 days/),
  ).toBeVisible();
  const cancel = preview.getByRole('button', { name: 'Cancel restore' });
  await expect(cancel).toBeFocused();
  await expect(cancel).toHaveAccessibleDescription(
    /Imported Trash older than 180 days/,
  );
  await page.keyboard.press('Enter');
  await expect(preview).toHaveCount(0);
});

test('Trash Details explains local cleanup for the web editor', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const details = page.getByRole('region', { name: 'Trash details' });
  await expect(details).toContainText('after more than 180 days in Trash');
  await expect(details).toContainText(
    'Scratchtree checks Trash when the web editor opens.',
  );
  await expect(details).not.toContainText('Synced Trash');
});

test('an invalid import keeps the active notes', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('textbox', { name: 'New note Markdown' })
    .fill('Keep my notes');
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":7}'),
  });
  await expect(
    page.getByRole('button', { name: 'Replace library', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Note stream' })
      .getByText('Keep my notes', { exact: true }),
  ).toBeVisible();
});
