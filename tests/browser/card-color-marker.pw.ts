import { expect, test, type Locator, type Page } from '@playwright/test';

async function seed(
  page: Page,
  items: {
    markdown: string;
    kind?: 'note' | 'tree';
    color?: 'teal';
  }[],
) {
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
  await page.evaluate(async (items) => {
    const t = (window as any).__test;
    t.seed({
      items: items.map((item) => ({ ...item, id: crypto.randomUUID() })),
      drafts: [],
      undoDeleteIds: [],
    });
    await t.controller.start();
  }, items);
  const cards = page.locator('.note-card');
  await expect(cards).toHaveCount(items.length);
  return cards;
}

async function expectLineBelow(card: Locator, iconSelector: string) {
  await expect
    .poll(() =>
      card.evaluate((node, selector) => {
        const line = node.querySelector('.note-color');
        if (!line) return null;
        const icon = node.querySelector(selector)!;
        const a = line.getBoundingClientRect();
        const b = icon.getBoundingClientRect();
        return {
          centered: Math.abs(a.left + a.width / 2 - b.left - b.width / 2) < 1,
          gap: a.top > b.bottom,
          vertical: a.height > a.width,
        };
      }, iconSelector),
    )
    .toEqual({ centered: true, gap: true, vertical: true });
}

test('the assigned color stays visible on a hovered note and in its inline editor', async ({
  page,
}) => {
  const cards = await seed(page, [
    { markdown: 'Two displayed rows\nThe second row', color: 'teal' },
    { markdown: 'No assigned color' },
  ]);
  const card = cards.first();
  const body = card.locator('.note-body');
  const grip = card.getByRole('button', { name: 'Reorder note' });
  const line = card.locator('.note-color');
  const idle = (await line.boundingBox())!;
  expect(idle.height).toBeGreaterThan(idle.width * 4);
  const before = await body.boundingBox();

  await body.hover();
  await expect(grip).toHaveCSS('color', 'rgb(98, 189, 196)');
  await expectLineBelow(card, '.drag-handle svg');
  expect(await body.boundingBox()).toEqual(before);

  await body.dblclick();
  await expect(
    page.getByRole('textbox', { name: 'Edit Markdown' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Root', exact: true }).hover();
  await expect(grip).toHaveCSS('opacity', '1');
  await expect(grip).toHaveCSS('color', 'rgb(98, 189, 196)');
  await expectLineBelow(card, '.drag-handle svg');
  await expect(cards.last().locator('.note-color')).toHaveCount(0);
});

test('a tree swaps its icon and grip over the same color line', async ({
  page,
}) => {
  const cards = await seed(page, [
    { kind: 'tree', markdown: 'One row', color: 'teal' },
    {
      kind: 'tree',
      markdown: '## Second tree\nTwo displayed rows',
      color: 'teal',
    },
  ]);
  const tree = cards.last();
  const line = tree.locator('.note-color');
  await expect(cards.first().locator('.note-color')).toBeHidden();
  await expectLineBelow(tree, '.tree-icon');
  const idle = await line.boundingBox();

  await tree.locator('.note-body').hover();
  await expect(tree.locator('.tree-icon')).toBeHidden();
  await expectLineBelow(tree, '.drag-handle svg');
  expect(await line.boundingBox()).toEqual(idle);

  await cards.first().locator('.note-body').hover();
  await expect(
    cards.first().getByRole('button', { name: 'Reorder note' }),
  ).toHaveCSS('color', 'rgb(98, 189, 196)');
  await expect(cards.first().locator('.note-color')).toBeHidden();
});

test('a tree line follows wrapping and the displayed preview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  const cards = await seed(page, [
    {
      kind: 'tree',
      markdown:
        'A one-line summary becomes two rows when the note stream is narrow enough.',
      color: 'teal',
    },
    {
      kind: 'tree',
      markdown: 'First\nSecond\nThird\nFourth\nFifth\nSixth',
      color: 'teal',
    },
  ]);
  const wraps = cards.first();
  await expect(wraps.locator('.note-color')).toBeHidden();
  await page.setViewportSize({ width: 640, height: 700 });
  await expectLineBelow(wraps, '.tree-icon');

  const long = cards.last();
  await expect(long.locator('.note-color')).toBeHidden();
  await long.getByRole('button', { name: 'Expand note' }).click();
  await expectLineBelow(long, '.tree-icon');
  await long.getByRole('button', { name: 'Collapse note' }).click();
  await expect(long.locator('.note-color')).toBeHidden();
});

test('an inline editor only adds the tail when a second row can be seen', async ({
  page,
}) => {
  const card = (
    await seed(page, [{ markdown: 'One row', color: 'teal' }])
  ).first();
  await card.locator('.note-body').dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await expect(editor).toBeFocused();
  await expect(card.locator('.note-color')).toBeHidden();
  await editor.press('End');
  await editor.press('Shift+Enter');
  await expectLineBelow(card, '.drag-handle svg');
  await editor.press('Backspace');
  await expect(card.locator('.note-color')).toBeHidden();
  await expect(editor).toBeFocused();
});

test('a wrapped whitespace-only edit still displays two rows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 700 });
  const card = (
    await seed(page, [{ markdown: 'One row', color: 'teal' }])
  ).first();
  await card.locator('.note-body').dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await editor.press('Meta+a');
  await page.keyboard.insertText(' '.repeat(175));
  await expectLineBelow(card, '.drag-handle svg');
});

test('a one-row editor hides wrapped source above the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 850 });
  const card = (
    await seed(page, [
      {
        markdown: `[Short link](#${'very-long-path-'.repeat(17)})\nSecond\nThird\nFourth\nFifth\nSixth`,
        color: 'teal',
      },
    ])
  ).first();
  await card.click({ position: { x: 3, y: 3 } });
  await page.keyboard.press('e');
  await expect(
    page.getByRole('textbox', { name: 'Edit Markdown' }),
  ).toBeFocused();
  await card.locator('.cm-scroller').evaluate((node) => {
    node.scrollTop = 20;
  });
  await page.setViewportSize({ width: 761, height: 850 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(card.locator('.note-color')).toHaveCSS('display', 'none');
});

test('the tree icon, line, and handle use the same light-theme accent', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const tree = (
    await seed(page, [
      { kind: 'tree', markdown: 'A tree\nTwo displayed rows', color: 'teal' },
    ])
  ).first();
  const ink = await tree
    .locator('.note-color')
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  await expect(tree.locator('.tree-icon')).toHaveCSS('color', ink);
  await tree.locator('.note-body').hover();
  await expect(tree.getByRole('button', { name: 'Reorder note' })).toHaveCSS(
    'color',
    ink,
  );
});
