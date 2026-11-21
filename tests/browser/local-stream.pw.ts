import { expect, test } from '@playwright/test';

test('blank queries use the current tree without scanning global search', async ({
  page,
}) => {
  await page.route('**/src/lib/domain/search.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        import { filterNotes as original } from './search.ts?original';
        export function filterNotes(items, query, scope) {
          (window.__streamSearchQueries ??= []).push(query.trim());
          return original(items, query, scope);
        }
      `,
    }),
  );
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
  const ids = await page.evaluate(async () => {
    const { repo, controller } = (window as any).__test;
    const ids = Array.from(
      { length: 5 },
      (_, i) => `00000000-0000-4000-8000-00000000000${i}`,
    );
    const root = { scope: 'live', itemId: null };
    const child = { scope: 'live', itemId: ids[0] };
    await repo.createChildTree({ id: ids[0], parent: root });
    for (const [i, location] of [child, root, child, root].entries()) {
      await repo.captureItem({
        id: ids[i + 1],
        location,
        markdown: `match ${i + 1}`,
        draft: {
          key: location.itemId ? `compose:${location.itemId}` : 'compose',
          revision: 0,
        },
      });
    }
    await repo.deleteItem(ids[4]);
    await repo.reorderItem({ id: ids[3], group: child, toIndex: 0 });
    await controller.start();
    await controller.openLocation(child);
    return ids;
  });

  const search = page.getByRole('searchbox');
  const cards = page
    .getByRole('region', { name: 'Note stream' })
    .locator('[data-entry-id]');
  const count = page.locator('.stream-header');
  const queries = () =>
    page.evaluate(() => (window as any).__streamSearchQueries ?? []);
  const expectEntries = async (entries: string[]) => {
    await expect(cards).toHaveCount(entries.length);
    await expect(count).toContainText(
      `${entries.length} ${entries.length === 1 ? 'note' : 'notes'}`,
    );
    expect(
      await cards.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-entry-id')),
      ),
    ).toEqual(entries);
  };

  await expectEntries([ids[3], ids[1]]);
  expect(await queries()).toEqual([]);

  await search.fill('match');
  await expectEntries([ids[1], ids[2], ids[3]]);
  expect(await queries()).toContain('match');
  await search.fill('   ');
  await expectEntries([ids[3], ids[1]]);
  expect(await queries()).not.toContain('');

  await search.clear();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expectEntries([ids[4]]);
  expect(await queries()).not.toContain('');
});
