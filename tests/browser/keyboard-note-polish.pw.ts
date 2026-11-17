import { test, expect, type Page } from '@playwright/test';

const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'New note Markdown' });
const stream = (page: Page) =>
  page.getByRole('region', { name: 'Note stream' });
const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"]`);
async function seed(page: Page, sources = ['first', 'middle', 'last']) {
  await page.addInitScript(() => {
    (window as any).__copies = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text: string) {
          if ((window as any).__copyFails) throw new Error('Clipboard denied');
          (window as any).__copies.push(text);
        },
      },
    });
  });
  await page.goto('/?fixture');
  await capture(page).waitFor();
  return page.evaluate(async (sources) => {
    const t = (window as any).__test;
    const ids = sources.map(() => crypto.randomUUID());
    t.seed({
      items: sources.map((markdown, i) => ({ id: ids[i], markdown })),
      drafts: [],
      undoDeleteIds: [],
    });
    await t.controller.start();
    return ids;
  }, sources);
}
const state = (page: Page) =>
  page.evaluate(() => structuredClone((window as any).__test.repo.snapshot));

test('Command-N without selection composes here without creating an item', async ({
  page,
}) => {
  await seed(page);
  const before = await state(page);
  await capture(page).press('Escape');
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  expect(await state(page)).toEqual(before);
});

test('Command-N enters the selected item and composes without an Untitled child', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[1]).click();
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.ownerId),
    )
    .toBe(ids[1]);
  const after = await state(page);
  expect(after.items).toHaveLength(3);
  expect(after.items.find((x: any) => x.id === ids[1])).toMatchObject({
    kind: 'tree',
    markdown: 'middle',
  });
});

test('Command-N into a nonempty tree focuses its composer', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    await t.repo.promoteItem(ids[0]);
    t.repo.snapshot.items.find((x: any) => x.id === ids[1]).parentId = ids[0];
    await t.controller.start();
  }, ids);
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+n');
  await expect(card(page, ids[1])).toBeVisible();
  await expect(capture(page)).toBeFocused();
});

test('sidebar hides completed subtrees and Command numbers follow visible direct trees', async ({
  page,
}) => {
  const ids = await seed(page, [
    'done parent',
    'hidden child',
    'first tree',
    'second tree',
    'nested tree',
  ]);
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    for (const id of ids) await t.repo.promoteItem(id);
    t.repo.snapshot.items[0].done = true;
    t.repo.snapshot.items[1].parentId = ids[0];
    t.repo.snapshot.items[4].parentId = ids[2];
    await t.controller.start();
  }, ids);
  const nav = page.getByRole('navigation', { name: 'Trees' });
  await expect(
    nav.getByRole('button', { name: 'Open tree done parent', exact: true }),
  ).toHaveCount(0);
  await expect(
    nav.getByRole('button', { name: 'Open tree hidden child', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Meta+2');
  await expect(page.locator('h1')).toHaveText('Root / first tree');
  await page.keyboard.press('Meta+3');
  await expect(page.locator('h1')).toHaveText('Root / second tree');
  await page.keyboard.press('Meta+9');
  await expect(page.locator('h1')).toHaveText('Root / second tree');
  await page.keyboard.press('Meta+1');
  await expect(page.locator('h1')).toHaveText('Root');
});

test('capture Up restores highlighted item including a tree before last-note fallback', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    await t.repo.promoteItem(id);
    await t.controller.start();
  }, ids[1]);
  await card(page, ids[1]).click();
  await page.keyboard.press('Space');
  await capture(page).fill('draft');
  await capture(page).press('Meta+Home');
  await page.keyboard.press('ArrowUp');
  await expect(stream(page)).toBeFocused();
  await expect(card(page, ids[1])).toHaveClass(/selected/);
  await expect(capture(page)).toHaveText('draft');
});

test('strikethrough styles edit text while retaining delimiters and literal code', async ({
  page,
}) => {
  const ids = await seed(page, ['~~crossed~~ and `~~literal~~`']);
  await card(page, ids[0]).dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await expect(
    editor.locator('.cm-strikethrough').filter({ hasText: 'crossed' }),
  ).toHaveCSS('text-decoration-line', 'line-through');
  await expect(editor).toHaveText('~~crossed~~ and `~~literal~~`');
  await expect(
    editor.locator('.cm-strikethrough').filter({ hasText: 'literal' }),
  ).toHaveCount(0);
});

test('code copy reports success and failure in workspace status without changing the note', async ({
  page,
}) => {
  const ids = await seed(page, [
    'before\n\n```js\nconst x = "<&>";\n\n  indented();\n```\n\nafter',
  ]);
  const button = card(page, ids[0]).getByRole('button', {
    name: 'Copy code',
    exact: true,
  });
  await card(page, ids[0]).getByText('before', { exact: true }).click();
  const before = await state(page);
  const renderedBefore = await card(page, ids[0]).innerText();
  const status = page.getByRole('region', { name: 'Editor status' });
  await button.click();
  await expect(status.getByRole('status')).toHaveText('Code copied');
  expect(await card(page, ids[0]).innerText()).toBe(renderedBefore);
  await expect(card(page, ids[0])).toHaveClass(/selected/);
  expect(await page.evaluate(() => (window as any).__copies)).toEqual([
    'const x = "<&>";\n\n  indented();\n',
  ]);
  expect(await state(page)).toEqual(before);
  await page.evaluate(() => ((window as any).__copyFails = true));
  await button.click();
  await expect(status.getByRole('alert')).toHaveText(
    'Copy failed. Your code is unchanged; retry Copy code.',
  );
  expect(await card(page, ids[0]).innerText()).toBe(renderedBefore);
  await expect(card(page, ids[0])).toHaveClass(/selected/);
  expect(await state(page)).toEqual(before);
  await page.evaluate(() => ((window as any).__copyFails = false));
  await button.press('Enter');
  await expect(status.getByRole('status')).toHaveText('Code copied');
  await expect(status.getByRole('alert')).toBeHidden();
  expect(await card(page, ids[0]).innerText()).toBe(renderedBefore);
  expect(await state(page)).toEqual(before);
});

test('move search starts focused, Enter is neutral, and Tab enables filtered list navigation', async ({
  page,
}) => {
  const ids = await seed(page, ['source', 'alpha', 'beta']);
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    for (const id of ids.slice(1)) await t.repo.promoteItem(id);
    await t.controller.start();
  }, ids);
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move notes' });
  const search = dialog.getByRole('searchbox', { name: 'Search destinations' });
  await expect(search).toBeFocused();
  await search.fill('BETA');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  const before = await state(page);
  await search.press('Enter');
  expect(await state(page)).toEqual(before);
  await expect(dialog).toBeVisible();
  await search.press('Tab');
  await expect(dialog.getByRole('listbox')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(
    (await state(page)).items.find((x: any) => x.id === ids[0]).parentId,
  ).toBe(ids[2]);
});

test('six rendered lines collapse to one line and expand to show the rest', async ({
  page,
}) => {
  const ids = await seed(page, [
    Array.from({ length: 6 }, (_, n) => `line ${n + 1}`).join('\n\n'),
  ]);
  const body = card(page, ids[0]).locator('.note-body');
  await expect(
    card(page, ids[0]).getByRole('button', { name: 'Expand note' }),
  ).toBeVisible();
  const lineHeight = await body.evaluate((el) =>
    parseFloat(getComputedStyle(el).lineHeight),
  );
  expect((await body.boundingBox())!.height).toBeLessThanOrEqual(
    lineHeight + 2,
  );
  await card(page, ids[0]).getByRole('button', { name: 'Expand note' }).click();
  expect((await body.boundingBox())!.height).toBeGreaterThan(lineHeight * 5);
  await card(page, ids[0])
    .getByRole('button', { name: 'Collapse note' })
    .click();
  expect((await body.boundingBox())!.height).toBeLessThanOrEqual(
    lineHeight + 2,
  );
});

test('palette shows one latest-input-owned hex/name tooltip outside the matching column', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  const orange = palette.getByRole('button', { name: 'Orange', exact: true });
  await orange.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText('#e5a05f (orange)');
  expect((await tooltip.boundingBox())!.x).toBeGreaterThanOrEqual(
    (await palette.boundingBox())!.x + (await palette.boundingBox())!.width,
  );
  await page.keyboard.press('Home');
  await expect(tooltip).toHaveText('#a0a0a0 (gray)');
  await page.keyboard.press('ArrowUp');
  await expect(tooltip).toHaveText('#ad95d9 (purple)');
  await palette.getByRole('button', { name: 'Green', exact: true }).hover();
  await expect(tooltip).toHaveText('#8dbe8a (green)');
  await page.keyboard.press('ArrowLeft');
  await expect(tooltip).toHaveText('#ad95d9 (purple)');
  expect(
    (await tooltip.boundingBox())!.x + (await tooltip.boundingBox())!.width,
  ).toBeLessThanOrEqual((await palette.boundingBox())!.x);
  await expect(tooltip).toHaveCount(1);
});

for (const lines of [5, 6])
  test(`${lines} rendered rows count text rather than paragraph margins`, async ({
    page,
  }) => {
    const ids = await seed(page, [
      Array.from({ length: lines }, (_, n) => `row ${n}`).join('\n\n'),
    ]);
    await expect(
      card(page, ids[0]).getByRole('button', { name: 'Expand note' }),
    ).toHaveCount(lines > 5 ? 1 : 0);
  });

test('wrapped text counts toward collapse and hidden code controls stay outside keyboard navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const ids = await seed(page, [
    'wrapped words '.repeat(100) + '\n\n```\ncode below preview\n```',
  ]);
  const note = card(page, ids[0]);
  await expect(note.getByRole('button', { name: 'Expand note' })).toBeVisible();
  expect(
    await note
      .locator('.code-copy')
      .evaluate((el) => el.closest('[inert]') !== null),
  ).toBe(true);
  await note.getByRole('button', { name: 'Expand note' }).click();
  await expect(note.getByRole('button', { name: 'Copy code' })).toBeVisible();
  expect(
    await note
      .locator('.code-copy')
      .evaluate((el) => el.closest('[inert]') !== null),
  ).toBe(false);
});

test('all Command-2 through Command-9 destinations use direct sibling order after nested rows', async ({
  page,
}) => {
  const ids = await seed(
    page,
    Array.from({ length: 9 }, (_, n) => `tree ${n}`),
  );
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    for (const id of ids) await t.repo.promoteItem(id);
    t.repo.snapshot.items[1].parentId = ids[0];
    for (const id of ids) {
      if (t.repo.snapshot.items.find((x: any) => x.id === id).parentId !== null)
        continue;
      await t.repo.captureItem({
        id: crypto.randomUUID(),
        location: { scope: 'live', itemId: id },
        markdown: 'retained child',
        draft: { key: `compose:${id}`, revision: 0 },
      });
    }
    await t.controller.start();
  }, ids);
  for (let key = 2; key <= 9; key++) {
    await page.keyboard.press(`Meta+${key}`);
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__test.controller.state.ownerId),
      )
      .toBe(ids[key === 2 ? 0 : key - 1]);
  }
});

test('Command-N flush failure retains source and captured target for Retry', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[1]).dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await editor.fill('latest retained source');
  await page.evaluate(() => ((window as any).__test.repo.fail = 'save'));
  await page.keyboard.press('Meta+n');
  await expect(editor).toHaveText('latest retained source');
  await expect(page.locator('h1')).toHaveText('Root');
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.ownerId),
    )
    .toBe(ids[1]);
  expect((await state(page)).items).toHaveLength(3);
});

test('Command-N Retry into a nonempty selected tree retains capture focus and empty selection', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    await t.repo.promoteItem(ids[0]);
    t.repo.snapshot.items[1].parentId = ids[0];
    await t.controller.start();
  }, ids);
  await card(page, ids[0]).dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await editor.fill('retained parent source');
  await page.evaluate(() => ((window as any).__test.repo.fail = 'save'));
  await page.keyboard.press('Meta+n');
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect(card(page, ids[1])).toBeVisible();
  await expect(capture(page)).toBeFocused();
  await expect(page.locator('.note-card.selected')).toHaveCount(0);
});

for (const source of [
  '```js\n' + 'firstCodeLine();\n'.repeat(6) + '```',
  Array.from({ length: 6 }, (_, n) => `> quoted row ${n}`).join('\n\n'),
])
  test(`collapsed first text row stays entirely visible: ${source.startsWith('```') ? 'code' : 'quote'}`, async ({
    page,
  }) => {
    const ids = await seed(page, [source]);
    const note = card(page, ids[0]);
    await expect(
      note.getByRole('button', { name: 'Expand note' }),
    ).toBeVisible();
    const rects = await note.locator('.note-body').evaluate((body) => {
      const element = body.querySelector('.code-line,blockquote p')!;
      const r = element.getBoundingClientRect(),
        b = body.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        bodyTop: b.top,
        bodyBottom: b.bottom,
      };
    });
    expect(rects.top).toBeGreaterThanOrEqual(rects.bodyTop - 1);
    expect(rects.bottom).toBeLessThanOrEqual(rects.bodyBottom + 1);
  });

test('code Copy never covers the first code row', async ({ page }) => {
  const ids = await seed(page, ['```js\nfirstLine();\n```']);
  const code = card(page, ids[0]).locator('.code-line');
  const text = await code.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const r = range.getBoundingClientRect();
    return { right: r.right };
  });
  const copy = await card(page, ids[0])
    .getByRole('button', { name: 'Copy code' })
    .boundingBox();
  expect(copy!.x).toBeGreaterThanOrEqual(text.right);
});

test('palette tooltip fits the viewport at 200% text without covering swatches', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 500 });
  const ids = await seed(page, ['note']);
  await card(page, ids[0]).click();
  await page.keyboard.press('l');
  await page.addStyleTag({ content: ':root { font-size:32px!important }' });
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  await palette
    .getByRole('button', { name: 'Gray', exact: true })
    .dispatchEvent('pointerenter');
  const tip = page.getByRole('tooltip');
  await expect(tip).toHaveText('#a0a0a0 (gray)');
  const box = (await tip.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(500);
  expect(box.x + box.width).toBeLessThanOrEqual(
    (await palette.boundingBox())!.x,
  );
});

test('long code scrolls within a region that leaves Copy unobstructed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const ids = await seed(page, [
    '```js\n' + 'longIdentifier();'.repeat(30) + '\n```',
  ]);
  const note = card(page, ids[0]);
  const code = note.locator('.code-block code');
  expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  expect(
    (await code.boundingBox())!.x + (await code.boundingBox())!.width,
  ).toBeLessThanOrEqual(
    (await note.getByRole('button', { name: 'Copy code' }).boundingBox())!.x,
  );
});

for (const theme of ['Light', 'Dark'])
  for (const scale of [100, 150])
    test(`code Copy matches the note Copy Markdown icon button in ${theme} at ${scale}%`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1000, height: 800 });
      const ids = await seed(page, ['```js\nconst value = 7;\n```']);
      await page.getByRole('radio', { name: theme, exact: true }).check();
      if (scale === 150)
        await page.addStyleTag({ content: ':root{font-size:24px!important}' });
      const note = card(page, ids[0]);
      await note.locator('.code-line').click();
      const noteCopy = note.getByRole('button', {
        name: 'Copy Markdown',
        exact: true,
      });
      const codeCopy = note.getByRole('button', {
        name: 'Copy code',
        exact: true,
      });
      await expect(codeCopy.locator('svg')).toHaveCount(1);
      await expect(codeCopy).toHaveText('');
      await expect(codeCopy).toHaveAttribute('title', 'Copy code');
      const geometry = (button: HTMLElement | SVGElement) => {
        const style = getComputedStyle(button);
        const svg = button.querySelector('svg')!;
        const icon = getComputedStyle(svg);
        return {
          button: Object.fromEntries(
            [
              'width',
              'height',
              'padding',
              'backgroundColor',
              'borderColor',
              'borderWidth',
              'borderRadius',
              'color',
            ].map((key) => [key, style[key as any]]),
          ),
          icon: Object.fromEntries(
            [
              'width',
              'height',
              'fill',
              'stroke',
              'strokeWidth',
              'strokeLinecap',
              'strokeLinejoin',
            ].map((key) => [key, icon[key as any]]),
          ),
          viewBox: svg.getAttribute('viewBox'),
          paths: Array.from(svg.querySelectorAll('path')).map((path) =>
            path.getAttribute('d'),
          ),
          hidden: svg.getAttribute('aria-hidden'),
        };
      };
      expect(await codeCopy.evaluate(geometry)).toEqual(
        await noteCopy.evaluate(geometry),
      );
      // WebKit's native button Tab order depends on full-keyboard-access preferences.
      await page.keyboard.press('Tab');
      await codeCopy.focus();
      await expect(codeCopy).toBeFocused();
      await expect(codeCopy).toHaveCSS('outline-style', 'solid');
      await page.screenshot({
        path: testInfo.outputPath(`copy-icon-${theme}-${scale}.png`),
      });
      await codeCopy.press('Enter');
      await expect
        .poll(() => page.evaluate(() => (window as any).__copies))
        .toEqual(['const value = 7;\n']);
      await codeCopy.locator('svg').click();
      await expect
        .poll(() => page.evaluate(() => (window as any).__copies))
        .toEqual(['const value = 7;\n', 'const value = 7;\n']);
      await expect(note).toHaveClass(/selected/);
    });
