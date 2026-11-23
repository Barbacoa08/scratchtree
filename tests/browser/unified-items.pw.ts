import { test, expect, type Page } from '@playwright/test';
import type { CaptureItem } from '../../src/lib/platform/workspace';
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'New note Markdown' });
const stream = (p: Page) => p.getByRole('region', { name: 'Note stream' });
const edit = (p: Page) => p.getByRole('textbox', { name: 'Edit Markdown' });
async function seed(p: Page, sources: string[]) {
  await p.goto('/?fixture');
  await capture(p).waitFor();
  return p.evaluate(async (sources) => {
    const t = (window as any).__test;
    const ids = [];
    for (const markdown of sources) {
      const id = crypto.randomUUID();
      ids.push(id);
      await t.repo.captureItem({
        id,
        location: { scope: 'live', itemId: null },
        markdown,
        draft: { key: 'compose', revision: 0 },
      });
    }
    await t.controller.start();
    return ids;
  }, sources);
}
test('selected note Command-N preserves latest source and enters that exact parent; tree Command-N composes there', async ({
  page,
}) => {
  const [id] = await seed(page, ['**parent**\r\n']);
  const parent = page.locator(`[data-entry-id="${id}"]`);
  await parent.click();
  await page.keyboard.press('e');
  await edit(page).fill('latest **source**\r\n');
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  let items = await page.evaluate(
    () => (window as any).__test.repo.snapshot.items,
  );
  expect(items).toHaveLength(1);
  expect(items.find((x: any) => x.id === id)).toMatchObject({
    kind: 'tree',
    markdown: 'latest **source**\r\n',
    parentId: null,
    position: 0,
  });
  await capture(page).fill('saved child');
  await capture(page).press('Enter');
  await page.keyboard.press('Meta+1');
  await parent.click();
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  items = await page.evaluate(() => (window as any).__test.repo.snapshot.items);
  expect(items.filter((x: any) => x.parentId === id)).toHaveLength(1);
});
test('Right promotes unchanged ID, empty destinations focus capture, and tree double-click edits with E at end and retained Undo', async ({
  page,
}) => {
  const [id] = await seed(page, ['**source**']);
  let card = page.locator(`[data-entry-id="${id}"]`);
  await card.click();
  await page.keyboard.press('ArrowRight');
  await expect(capture(page)).toBeFocused();
  await page.keyboard.press('Meta+1');
  await card.dblclick();
  await expect(edit(page)).toHaveText('**source**');
  await edit(page).press('Meta+End');
  await page.keyboard.insertText(' appended');
  await edit(page).press('Escape');
  await stream(page).press('e');
  await page.keyboard.insertText('!');
  await expect(edit(page)).toHaveText('**source** appended!');
  await edit(page).press('Meta+z');
  await expect(edit(page)).toHaveText('**source** appended');
  await edit(page).press('Escape');
  expect(
    await page.evaluate(() => (window as any).__test.repo.snapshot.items[0].id),
  ).toBe(id);
});
test('mixed deletion selects same ordinal, preserves tree tree and edit histories, and Undo returns source', async ({
  page,
}) => {
  const ids = await seed(page, ['first', 'middle', 'last']);
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    await t.repo.promoteItem(id);
    await t.controller.start();
  }, ids[1]);
  const middle = page.locator(`[data-entry-id="${ids[1]}"]`);
  await middle.dblclick();
  await edit(page).press('Meta+End');
  await page.keyboard.insertText(' changed');
  await edit(page).press('Escape');
  await page.keyboard.press('Meta+Backspace');
  await expect(page.locator(`[data-entry-id="${ids[2]}"]`)).toHaveClass(
    /selected/,
  );
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await middle.click();
  await page.keyboard.press('e');
  await expect(edit(page)).toHaveText('middle changed');
  await edit(page).press('Meta+z');
  await expect(edit(page)).toHaveText('middle');
});
test('blank stream background clears selection after flush; Command-N then uses current location, while composer Escape preserves a highlight', async ({
  page,
}) => {
  const [id] = await seed(page, ['parent']);
  const card = page.locator(`[data-entry-id="${id}"]`);
  await card.click();
  await page.keyboard.press('Space');
  await capture(page).press('Escape');
  await expect(card).toHaveClass(/selected/);
  await page.keyboard.press('e');
  await edit(page).fill('latest source');
  const box = (await stream(page).boundingBox())!;
  await stream(page).click({
    position: { x: box.width - 10, y: box.height - 10 },
  });
  await expect(card).not.toHaveClass(/selected/);
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  const items = await page.evaluate(
    () => (window as any).__test.repo.snapshot.items,
  );
  expect(items.find((x: any) => x.id === id)).toMatchObject({
    kind: 'note',
    markdown: 'latest source',
  });
  expect(items).toHaveLength(1);
});

test('failed Delete has its own retry and keeps same ordinal focus without submitting capture', async ({
  page,
}) => {
  const ids = await seed(page, ['first', 'second']);
  await page.locator(`[data-entry-id="${ids[0]}"]`).click();
  await capture(page).fill('unsubmitted capture');
  await capture(page).press('Escape');
  await page.evaluate(() => ((window as any).__test.repo.fail = 'delete'));
  await page.keyboard.press('Meta+Backspace');
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect(page.locator(`[data-entry-id="${ids[1]}"]`)).toHaveClass(
    /selected/,
  );
  await expect(stream(page)).toBeFocused();
  await expect(capture(page)).toHaveText('unsubmitted capture');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items.length,
    ),
  ).toBe(2);
});
test('selected global result becomes Command-N parent instead of the current open container', async ({
  page,
}) => {
  const ids = await seed(page, ['current owner', 'selected result']);
  await page.locator(`[data-entry-id="${ids[0]}"]`).click();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('searchbox').fill('selected result');
  await page.locator(`[data-entry-id="${ids[1]}"]`).click();
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  const s = await page.evaluate(() => (window as any).__test.repo.snapshot);
  expect(s.items.find((x: any) => x.id === ids[1]).kind).toBe('tree');
  expect(s.items).toHaveLength(2);
  expect(
    await page.evaluate(() => (window as any).__test.controller.state.ownerId),
  ).toBe(ids[1]);
  expect(await page.getByRole('searchbox').inputValue()).toBe('');
});
test('deleting the open container through global search returns Root and retains its scoped draft for Undo', async ({
  page,
}) => {
  const [id] = await seed(page, ['current owner']);
  await page.locator(`[data-entry-id="${id}"]`).click();
  await page.keyboard.press('ArrowRight');
  await capture(page).fill('retained owner draft');
  await page.getByRole('searchbox').fill('current owner');
  await page.locator(`[data-entry-id="${id}"]`).click();
  await page.keyboard.press('Meta+Backspace');
  await expect(page.locator('h1')).toHaveText('Root');
  await expect(capture(page)).toBeFocused();
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await page.getByRole('searchbox').press('Escape');
  await page.locator(`[data-entry-id="${id}"]`).click();
  await page.keyboard.press('ArrowRight');
  await expect(capture(page)).toHaveText('retained owner draft');
});
test('blank-background source flush preserves newer Search focus and query', async ({
  page,
}) => {
  const [id] = await seed(page, ['source']);
  await page.locator(`[data-entry-id="${id}"]`).dblclick();
  await edit(page).fill('latest');
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.delaySave = new Promise<void>(
      (resolve) => (t.releaseSave = resolve),
    );
  });
  const box = (await stream(page).boundingBox())!;
  await stream(page).click({
    position: { x: box.width - 10, y: box.height - 10 },
  });
  await page.getByRole('searchbox').fill('newer query');
  await page.evaluate(() => (window as any).__test.releaseSave());
  await expect(edit(page)).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('newer query');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items[0].markdown,
    ),
  ).toBe('latest');
});
test('Capture Up falls back to displayed note rank and preserves a valid highlight in search', async ({
  page,
}) => {
  const ids = await seed(page, ['match first-created', 'match second-created']);
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    const tree = crypto.randomUUID();
    await t.repo.createChildTree({
      id: tree,
      parent: { scope: 'live', itemId: null },
    });
    await t.repo.saveItemSource(tree, 'match tree', {
      key: tree,
      revision: 0,
    });
    for (const x of t.repo.snapshot.items) {
      if (x.id === ids[0]) {
        x.position = 2;
        x.createdAt = 1;
        x.updatedAt = 1;
      } else if (x.id === ids[1]) {
        x.position = 0;
        x.createdAt = 2;
        x.updatedAt = 2;
      } else {
        x.position = 1;
        x.createdAt = 3;
        x.updatedAt = 3;
      }
    }
    await t.controller.start();
  }, ids);
  const entries = stream(page).getByRole('article');
  expect(
    await entries.evaluateAll((nodes) =>
      nodes.map((x) => x.getAttribute('data-entry-id')),
    ),
  ).toEqual([ids[1], expect.any(String), ids[0]]);
  await capture(page).fill('retained draft');
  await capture(page).press('Meta+Home');
  await capture(page).press('ArrowUp');
  await expect(page.locator(`[data-entry-id="${ids[0]}"]`)).toHaveClass(
    /selected/,
  );
  await expect(stream(page)).toBeFocused();
  await expect(capture(page)).toHaveText('retained draft');
  await page.getByRole('searchbox').fill('match');
  await capture(page).focus();
  await capture(page).press('Meta+Home');
  await capture(page).press('ArrowUp');
  await expect(page.locator(`[data-entry-id="${ids[0]}"]`)).toHaveClass(
    /selected/,
  );
  await expect(stream(page)).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('match');
  await expect(capture(page)).toHaveText('retained draft');
});
test('capture previews the submitted source while an older write holds the queue', async ({
  page,
}) => {
  await seed(page, ['existing']);
  await capture(page).fill('first **source**');
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.delayCheckpoint();
    t.delay();
    void t.controller.flush();
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.repo.checkpointCalls),
    )
    .toBe(1);
  await capture(page).press('Enter');
  const pending = stream(page).locator('.pending-capture');
  await expect(pending).toBeVisible();
  await expect(pending.locator('strong')).toHaveText('source');
  await expect(stream(page).getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('status')).toHaveText(
    'Saving note… Submit again when this save finishes.',
  );
  await expect(capture(page)).toBeFocused();
  await expect(capture(page)).toHaveText('first **source**');
  await expect(stream(page).locator('[data-entry-id]')).toHaveCount(1);
  await expect(stream(page).locator(':scope > :last-child')).toHaveClass(
    /pending-capture/,
  );
  expect(await stream(page).evaluate((node) => node.scrollTop)).toBe(0);

  await capture(page).press('Enter');
  await capture(page).fill('newer draft');
  await expect(pending).toContainText('first source');
  await expect(page.locator('.composer .hint')).toContainText(
    'Submit again when this save finishes',
  );
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.releaseCheckpoint();
    t.release();
  });
  await expect(pending).toHaveCount(0);
  await expect(stream(page).locator('.note-card.selected')).toContainText(
    'first source',
  );
  await expect(capture(page)).toHaveText('newer draft');
  await expect(capture(page)).toBeFocused();
  const saved = await page.evaluate(() =>
    (window as any).__test.repo.snapshot.items.map(
      (item: any) => item.markdown,
    ),
  );
  expect(saved).toEqual(['existing', 'first **source**']);
});

test('capture reveals only the clipped part of the pending slot and keeps composer focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1120, height: 620 });
  const ids = await seed(
    page,
    Array.from({ length: 32 }, (_, i) => `Existing note ${i + 1}`),
  );
  const notes = stream(page);
  const last = notes.locator(`[data-entry-id="${ids.at(-1)}"]`);
  await last.evaluate((node) => node.scrollIntoView({ block: 'end' }));
  await page.evaluate(() => (window as any).__test.delay());
  await capture(page).fill('**Saved here**');
  const before = await notes.evaluate((node) => node.scrollTop);
  await capture(page).press('Enter');
  const pending = notes.locator('.pending-capture');
  await expect(pending).toBeVisible();
  await expect(capture(page)).toBeFocused();
  const slot = await pending.elementHandle();
  const captureId = await pending.getAttribute('data-pending-capture');
  const position = await pending.evaluate((node) => {
    const stream = node.parentElement!;
    const card = node.getBoundingClientRect();
    const bottom =
      stream.getBoundingClientRect().top +
      stream.clientTop +
      stream.clientHeight;
    return {
      scroll: stream.scrollTop,
      gap: bottom - card.bottom,
      height: card.height,
      previous: node.previousElementSibling?.getAttribute('data-entry-id'),
    };
  });
  expect(position.previous).toBe(ids.at(-1));
  expect(position.scroll).toBeGreaterThan(before);
  expect(position.scroll - before).toBeLessThan(position.height + 10);
  expect(position.gap).toBeGreaterThanOrEqual(-1);
  expect(position.gap).toBeLessThan(4);

  await page.evaluate(() => (window as any).__test.release());
  await expect(notes.locator('[data-entry-id].selected')).toContainText(
    'Saved here',
  );
  expect(captureId).toBeTruthy();
  expect(await slot!.getAttribute('data-entry-id')).toBe(captureId);
  expect(await notes.evaluate((node) => node.scrollTop)).toBe(position.scroll);
  await expect(capture(page)).toBeFocused();
});

test('acknowledgment respects a newer scroll in the note stream', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1120, height: 620 });
  await seed(
    page,
    Array.from({ length: 32 }, (_, i) => `Note ${i + 1}`),
  );
  await page.evaluate(() => (window as any).__test.delay());
  await capture(page).fill('Save offscreen');
  await capture(page).press('Enter');
  const notes = stream(page);
  await expect(notes.locator('.pending-capture')).toBeVisible();
  expect(await notes.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await notes.evaluate((node) => (node.scrollTop = 0));
  await page.evaluate(() => (window as any).__test.release());
  await expect(notes.locator('[data-entry-id].selected')).toContainText(
    'Save offscreen',
  );
  expect(await notes.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(capture(page)).toBeFocused();
});

test('capture acknowledgment keeps its own note visible when another capture commits first', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1120, height: 620 });
  await seed(
    page,
    Array.from({ length: 32 }, (_, i) => `Note ${i + 1}`),
  );
  await page.evaluate(() => {
    const t = (window as any).__test;
    const capture = t.repo.captureItem.bind(t.repo);
    const gate = new Promise<void>((resolve) => {
      t.releaseConcurrentCapture = resolve;
    });
    t.repo.captureItem = async (request: CaptureItem) => {
      await gate;
      await capture({
        ...request,
        id: crypto.randomUUID(),
        markdown: 'concurrent note',
        draft: { key: 'compose', revision: 0 },
      });
      return capture(request);
    };
  });
  await capture(page).fill('my note');
  await capture(page).press('Enter');
  const notes = stream(page);
  await expect(notes.locator('.pending-capture')).toBeInViewport({
    ratio: 0.99,
  });
  await page.evaluate(() => (window as any).__test.releaseConcurrentCapture());
  const saved = notes.locator('[data-entry-id].selected');
  await expect(saved).toContainText('my note');
  await expect(saved).toBeInViewport({ ratio: 0.99 });
  await expect(capture(page)).toBeFocused();
});

test('a pending Root capture preserves the destination selection of an older navigation', async ({
  page,
}) => {
  const [tree] = await seed(page, ['Destination']);
  await page.evaluate(async (tree) => {
    const t = (window as any).__test;
    await t.repo.captureItem({
      id: crypto.randomUUID(),
      location: { scope: 'live', itemId: tree },
      markdown: 'destination child',
      draft: { key: `compose:${tree}`, revision: 0 },
    });
    await t.controller.start();
    t.delayCheckpoint();
  }, tree);
  await capture(page).fill('captured in Root');
  await page.getByRole('button', { name: 'Open tree Destination' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.repo.checkpointCalls),
    )
    .toBe(1);
  await capture(page).press('Enter');
  await expect(page.locator('.pending-capture')).toBeVisible();
  await page.evaluate(() => (window as any).__test.releaseCheckpoint());
  await expect(stream(page).locator('.note-card.selected')).toContainText(
    'destination child',
  );
  await expect(page.locator('.pending-capture')).toHaveCount(0);
  const saved = await page.evaluate(() =>
    (window as any).__test.repo.snapshot.items.find(
      (item: any) => item.markdown === 'captured in Root',
    ),
  );
  expect(saved).toMatchObject({ parentId: null, deletedAt: null });
});

test('an empty newer draft retains undo history after the first capture saves', async ({
  page,
}) => {
  await seed(page, []);
  await page.evaluate(() => (window as any).__test.delay());
  await capture(page).fill('captured source');
  await capture(page).press('Enter');
  await expect(page.locator('.pending-capture')).toBeVisible();
  await capture(page).fill('newer source');
  await capture(page).press('Meta+a');
  await capture(page).press('Backspace');
  await expect(capture(page)).toHaveText('');
  await page.evaluate(() => (window as any).__test.release());
  await expect(page.locator('.pending-capture')).toHaveCount(0);
  await expect(stream(page).locator('.note-card')).toContainText(
    'captured source',
  );
  await capture(page).press('Meta+z');
  await expect(capture(page)).toHaveText('newer source');
});

for (const later of ['later source', 'original source'])
  test(`lost capture acknowledgment reconciles original ID while retaining newer editor source/revision: ${later}`, async ({
    page,
  }) => {
    await seed(page, []);
    await page.evaluate(() => {
      const t = (window as any).__test,
        capture = t.repo.captureItem.bind(t.repo);
      let lost = true;
      t.repo.captureItem = async (request: any) => {
        const result = await capture(request);
        if (lost) {
          lost = false;
          throw new Error('Synthetic lost acknowledgment');
        }
        return result;
      };
    });
    await capture(page).fill('original source');
    await capture(page).press('Enter');
    await expect(page.getByRole('alert')).toContainText(
      'Synthetic lost acknowledgment',
    );
    const original = await page.evaluate(
      () => (window as any).__test.repo.snapshot.items[0],
    );
    await capture(page).fill('temporary source');
    await capture(page).fill(later);
    const revision = await page.evaluate(
      () => (window as any).__test.controller.state.buffers.compose.revision,
    );
    await capture(page).press('Enter');
    await page.evaluate(() => (window as any).__test.controller.flush());
    await expect(capture(page)).toHaveText(later);
    const actual = await page.evaluate(() => {
      const t = (window as any).__test;
      return {
        items: t.repo.snapshot.items,
        buffer: t.controller.state.buffers.compose,
        draft: t.repo.snapshot.drafts.find((d: any) => d.key === 'compose'),
      };
    });
    expect(actual.items).toEqual([original]);
    expect(actual.buffer).toEqual({ source: later, revision });
    expect(actual.draft).toMatchObject({ markdown: later, revision });
  });
test('known absent capture after precommit capacity rejection accepts corrected editor source without workspace replacement', async ({
  page,
}) => {
  await seed(page, []);
  await page.evaluate(() => {
    const t = (window as any).__test,
      capture = t.repo.captureItem.bind(t.repo);
    let reject = true;
    t.repo.captureItem = async (request: any) => {
      if (reject) {
        reject = false;
        throw {
          code: 'capacity_exceeded',
          message: 'Synthetic precommit capacity rejection',
        };
      }
      return capture(request);
    };
  });
  await capture(page).fill('rejected capture source');
  await capture(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic precommit capacity rejection',
  );
  expect(
    await page.evaluate(() => (window as any).__test.repo.snapshot.items),
  ).toHaveLength(0);
  await expect(capture(page)).toHaveText('rejected capture source');
  await capture(page).fill('corrected capture source');
  await capture(page).press('Enter');
  await expect(capture(page)).toHaveText('');
  const items = await page.evaluate(
    () => (window as any).__test.repo.snapshot.items,
  );
  expect(items).toHaveLength(1);
  expect(items[0].markdown).toBe('corrected capture source');
});
