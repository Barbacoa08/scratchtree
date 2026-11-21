import { expect, test } from '@playwright/test';

test('the reorder preview seeds its own store once', async ({ page }) => {
  test.skip(process.env.VITE_SCRATCHTREE_REORDER_PREVIEW !== '1');

  await page.goto('/');
  const stream = page.getByRole('region', { name: 'Note stream' });
  await expect(
    page.getByText('Synthetic comparison data', { exact: true }),
  ).toBeVisible();
  await expect(stream.locator('[data-entry-id]')).toHaveCount(24);

  const inventory = await page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(({ name }) => name);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('scratchtree-reorder-preview-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const notes = await new Promise<{ kind: string }[]>((resolve, reject) => {
        const request = database
          .transaction('notes')
          .objectStore('notes')
          .getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return {
        names,
        notes: notes.length,
        trees: notes.filter(({ kind }) => kind === 'tree').length,
      };
    } finally {
      database.close();
    }
  });
  expect(inventory).toEqual({
    names: ['scratchtree-reorder-preview-v1'],
    notes: 612,
    trees: 48,
  });

  const composer = page.getByRole('textbox', { name: 'New note Markdown' });
  await composer.fill('Preview edit survives reload');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(stream.locator('[data-entry-id]')).toHaveCount(25);
  await page.reload();
  await expect(stream.locator('[data-entry-id]')).toHaveCount(25);
  await expect(
    stream.getByText('Preview edit survives reload', { exact: true }),
  ).toBeAttached();
});
