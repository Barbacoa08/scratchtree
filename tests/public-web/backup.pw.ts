import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { BackupV8 } from '../../src/lib/sync/backup';

test('restore and offline backup preserve the exact portable library', async ({
  page,
}) => {
  const path = 'tests/fixtures/valid-v8.json';
  const original = JSON.parse(await readFile(path, 'utf8')) as BackupV8;
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await (await chooser).setFiles(path);
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
  await expect(page.getByText('Keep my notes', { exact: true })).toBeVisible();
});
