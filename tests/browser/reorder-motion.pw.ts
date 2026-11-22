import { test, expect, type Page } from '@playwright/test';
const card = (p: Page, id: string) => p.locator(`[data-entry-id="${id}"]`);
const handle = (p: Page, id: string) =>
  card(p, id).getByRole('button', { name: 'Reorder note', exact: true });
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'New note Markdown' });
async function seed(
  p: Page,
  sources = ['first **exact**', 'tree source', 'last `exact`'],
  fixtureUrl = '/?fixture',
) {
  await p.setViewportSize({ width: 1400, height: 900 });
  await p.goto(fixtureUrl);
  await expect(capture(p)).toBeVisible();
  return p.evaluate(async (sources) => {
    const t = (window as any).__test;
    const ids: string[] = [];
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
    await t.repo.promoteItem(ids[1]);
    await t.controller.start();
    return ids;
  }, sources);
}
const order = (p: Page) =>
  p
    .locator('.note-card')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-entry-id')));
const active = (p: Page) =>
  p.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (a) =>
            (a.effect as KeyframeEffect)?.target instanceof Element &&
            ((a.effect as KeyframeEffect).target as Element).matches(
              '.note-card',
            ) &&
            a.playState !== 'finished',
        ).length,
  );
async function moving(p: Page) {
  await expect
    .poll(() => active(p), { intervals: [10, 20, 30] })
    .toBeGreaterThan(0);
}
async function pauseMotion(p: Page) {
  await p.evaluate(() => {
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect)?.target;
      if (target instanceof Element && target.matches('.note-card')) {
        animation.pause();
        animation.currentTime = 100;
      }
    }
  });
}
async function settled(p: Page) {
  await expect.poll(() => active(p), { intervals: [20, 50] }).toBe(0);
  expect(
    await p
      .locator('.note-card')
      .evaluateAll((els) =>
        els.every((el) => getComputedStyle(el).transform === 'none'),
      ),
  ).toBe(true);
}
async function saveNodes(p: Page) {
  await p.locator('.note-card').evaluateAll((els) => {
    (window as any).__motionNodes = els;
  });
}
async function sameNodes(p: Page) {
  expect(
    await p
      .locator('.note-card')
      .evaluateAll((els) =>
        els.every((el) => (window as any).__motionNodes.includes(el)),
      ),
  ).toBe(true);
}
test('each keyboard tap moves real cards within the visible feedback budget while a reorder write is held', async ({
  page,
}) => {
  const ids = await seed(page);
  const selected = card(page, ids[2]);
  const stream = page.getByRole('region', { name: 'Note stream' });
  await selected.click();
  await expect(stream).toBeFocused();
  await saveNodes(page);
  await selected.evaluate((element) => {
    const fixture = (window as any).__test;
    const move = fixture.repo.moveItems.bind(fixture.repo);
    fixture.reorderWrites = 0;
    fixture.repo.moveItems = async (request: any) => {
      fixture.reorderWrites++;
      await new Promise<void>((resolve) => {
        fixture.releaseReorder = resolve;
      });
      return move(request);
    };
    fixture.firstDisplacement = new Promise<number | null>((resolve) => {
      function measure(event: KeyboardEvent) {
        if (
          event.key !== 'ArrowUp' ||
          !event.metaKey ||
          event.repeat ||
          event.altKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.isComposing
        )
          return;
        document.removeEventListener('keydown', measure, true);
        const start = performance.now();
        const originalY = element.getBoundingClientRect().y;
        const sample = (now: number) => {
          if (Math.abs(element.getBoundingClientRect().y - originalY) >= 2)
            resolve(now - start);
          else if (now - start >= 120) resolve(null);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }
      document.addEventListener('keydown', measure, true);
    });
  });
  await page.keyboard.down('Meta');
  try {
    await page.keyboard.press('ArrowUp');
    const displacement = await page.evaluate(
      () => (window as any).__test.firstDisplacement,
    );
    expect
      .soft(displacement, 'milliseconds to first visible displacement')
      .not.toBeNull();
    if (displacement !== null)
      expect.soft(displacement).toBeLessThanOrEqual(100);
    await test.info().attach('first-visible-feedback', {
      body: JSON.stringify({ milliseconds: displacement }),
      contentType: 'application/json',
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).__test.reorderWrites))
      .toBe(1);
    await page.keyboard.press('ArrowUp');
    expect.soft(await order(page)).toEqual([ids[2], ids[0], ids[1]]);
    expect(
      await page.evaluate(() =>
        (window as any).__test.repo.snapshot.items.map(
          (item: any) => item.position,
        ),
      ),
    ).toEqual([0, 1, 2]);
    await page.evaluate(() => (window as any).__test.releaseReorder());
    await expect
      .poll(() => page.evaluate(() => (window as any).__test.reorderWrites))
      .toBe(2);
    await page.evaluate(() => (window as any).__test.releaseReorder());
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__test.repo.snapshot.items.map(
            (item: any) => item.position,
          ),
        ),
      )
      .toEqual([1, 2, 0]);
  } finally {
    await page.keyboard.up('Meta');
  }
  await expect(
    selected.getByRole('button', { name: 'Select note' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(stream).toBeFocused();
  await sameNodes(page);
});
// Verify cosmetic movement, keyed identity, scroll bounds, and exact saved source.
test('projected keyboard reorder animates real keyed cards without changing source or viewport', async ({
  page,
}) => {
  const ids = await seed(page);
  await saveNodes(page);
  const before = await page.evaluate(() =>
    structuredClone((window as any).__test.repo.snapshot),
  );
  const y0 = (await card(page, ids[1]).boundingBox())!.y;
  const destinationY = (await card(page, ids[0]).boundingBox())!.y;
  await page.evaluate(() => {
    const t = (window as any).__test,
      reorder = t.repo.moveItems.bind(t.repo);
    t.repo.moveItems = async (request: any) => {
      await new Promise<void>((r) => {
        t.releaseReorder = r;
      });
      return reorder(request);
    };
  });
  await handle(page, ids[1]).focus();
  await page.keyboard.press('Meta+ArrowUp');
  await expect.poll(() => order(page)).toEqual([ids[1], ids[0], ids[2]]);
  expect(
    await page.evaluate(() => (window as any).__test.repo.snapshot),
  ).toEqual(before);
  await moving(page);
  const samples = await card(page, ids[1]).evaluate((el) => {
    const animation = el.getAnimations()[0];
    animation.pause();
    const ys = [0, 75, 150, 225, 300].map((time) => {
      animation.currentTime = time;
      return el.getBoundingClientRect().y;
    });
    animation.finish();
    return ys;
  });
  expect(samples[0]).toBeCloseTo(y0, 1);
  expect(samples[4]).toBeCloseTo(destinationY, 1);
  expect(samples[1]).toBeLessThan(y0 + (destinationY - y0) / 4);
  expect(samples[2]).toBeGreaterThan(samples[4]);
  expect(samples[2]).toBeLessThan(samples[0]);
  for (let i = 1; i < samples.length; i++)
    expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
  await settled(page);
  await sameNodes(page);
  await expect(handle(page, ids[1])).toBeFocused();
  await expect(handle(page, ids[0])).toBeDisabled();
  await expect(handle(page, ids[1])).toHaveAttribute('draggable', 'false');
  await page.waitForFunction(() => (window as any).__test.releaseReorder);
  await page.evaluate(() => (window as any).__test.releaseReorder());
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__test.controller.state.keyboardOrder,
      ),
    )
    .toBeNull();
  await expect(handle(page, ids[0])).toBeEnabled();
  const after = await page.evaluate(() => (window as any).__test.repo.snapshot);
  expect(
    after.items.map(({ id, markdown, kind, parentId, done, color }: any) => ({
      id,
      markdown,
      kind,
      parentId,
      done,
      color,
    })),
  ).toEqual(
    before.items.map(({ id, markdown, kind, parentId, done, color }: any) => ({
      id,
      markdown,
      kind,
      parentId,
      done,
      color,
    })),
  );
  expect(after.items.map((x: any) => x.position)).toEqual([1, 0, 2]);
  expect(
    await page.locator('.note-stream').evaluate((el) => el.scrollTop),
  ).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
test('native close flushes the optimistic reorder before the debounce expires', async ({
  page,
}) => {
  const ids = await seed(page, undefined, '/?fixture&lifecycle');
  const outcome = await handle(page, ids[1]).evaluate(async (grip) => {
    const t = (window as any).__test;
    const move = t.repo.moveItems.bind(t.repo);
    let writes = 0;
    t.repo.moveItems = (request: any) => {
      writes++;
      return move(request);
    };
    grip.focus();
    grip.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const beforeClose = { writes, order: t.controller.state.keyboardOrder };
    await t.requestClose();
    return {
      beforeClose,
      writes,
      hidden: t.windowState.hidden,
      positions: t.repo.snapshot.items.map((item: any) => item.position),
    };
  });
  expect(outcome).toEqual({
    beforeClose: { writes: 0, order: [ids[1], ids[0], ids[2]] },
    writes: 1,
    hidden: 1,
    positions: [1, 0, 2],
  });
});
test('real sibling drag animates the committed note with one actionable keyed row and no source rewrite', async ({
  page,
}) => {
  const ids = await seed(page);
  await saveNodes(page);
  const target = card(page, ids[2]),
    bounds = (await target.boundingBox())!;
  await card(page, ids[0]).hover();
  await handle(page, ids[0]).dragTo(target, {
    targetPosition: { x: bounds.width / 2, y: bounds.height * 0.75 },
  });
  await expect.poll(() => order(page)).toEqual([ids[1], ids[2], ids[0]]);
  await moving(page);
  await settled(page);
  await sameNodes(page);
  await expect(card(page, ids[0])).toHaveCount(1);
  await expect(card(page, ids[0]).locator('.markdown-view')).toContainText(
    'first exact',
  );
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__test.repo.snapshot.items.find((x: any) => x.id === id)
          .markdown,
      ids[0],
    ),
  ).toBe('first **exact**');
});
test('failed order is visible with compact retry, while boundary, source, membership, and search updates create no reorder animation', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'move';
  });
  await handle(page, ids[0]).press('Meta+ArrowDown');
  await expect(page.getByRole('alert')).toContainText('failure');
  expect(await order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await settled(page);
  await page.getByRole('button', { name: 'Hide Details' }).click();
  const retry = page.getByRole('button', { name: 'Retry reorder' });
  await expect(retry).toBeInViewport();
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await retry.click();
  await expect(retry).toHaveCount(0);
  await handle(page, ids[1]).press('Meta+ArrowUp');
  await settled(page);
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    t.controller.editContext(id, 'edited **source**');
    await t.controller.flush();
  }, ids[0]);
  await settled(page);
  await capture(page).fill('new member');
  await page.keyboard.press('Enter');
  await expect(page.locator('.note-card')).toHaveCount(4);
  await settled(page);
  await page.getByRole('searchbox').fill('source');
  await expect(page.locator('.note-card')).toHaveCount(2);
  await settled(page);
});
test('reduced motion starts immediate and switching it on settles active movement', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      page.evaluate(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
    )
    .toBe(true);
  await handle(page, ids[1]).press('Meta+ArrowUp');
  await expect.poll(() => order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await settled(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect
    .poll(() =>
      page.evaluate(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
    )
    .toBe(false);
  await handle(page, ids[1]).press('Meta+ArrowDown');
  await moving(page);
  await pauseMotion(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      page.evaluate(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
    )
    .toBe(true);
  await settled(page);
  expect(await order(page)).toEqual(ids);
});
for (const interruption of [
  'scroll',
  'resize',
  'navigate',
  'search',
  'hide',
  'drag',
] as const)
  test(`${interruption} cancels in-flight motion without residual transforms or stale replay`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const ids = await seed(page);
    await handle(page, ids[1]).press('Meta+ArrowUp');
    await moving(page);
    await pauseMotion(page);
    if (interruption === 'scroll')
      await page.locator('.note-stream').dispatchEvent('scroll');
    if (interruption === 'resize')
      await page.setViewportSize({ width: 1300, height: 800 });
    if (interruption === 'navigate')
      await page.getByRole('button', { name: 'Trash', exact: true }).click();
    if (interruption === 'search')
      await page.getByRole('searchbox').fill('last');
    if (interruption === 'hide')
      await page.evaluate(() =>
        document.dispatchEvent(new Event('visibilitychange')),
      );
    if (interruption === 'drag')
      await handle(page, ids[1]).evaluate((el) =>
        el.dispatchEvent(
          new DragEvent('dragstart', {
            dataTransfer: new DataTransfer(),
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    await settled(page);
    if (interruption === 'navigate') {
      await page.getByRole('button', { name: 'Root', exact: true }).click();
      await settled(page);
    }
    expect(errors).toEqual([]);
  });
test('rapid reversal retargets current visuals, then settles latest authoritative order with source and focus intact', async ({
  page,
}) => {
  const ids = await seed(page);
  await saveNodes(page);
  await handle(page, ids[1]).press('Meta+ArrowUp');
  await moving(page);
  const mid = await card(page, ids[1]).evaluate((el) => {
    const animation = el.getAnimations()[0];
    animation.pause();
    animation.currentTime = 100;
    return el.getBoundingClientRect().y;
  });
  await handle(page, ids[1]).press('Meta+ArrowDown');
  await expect.poll(() => order(page)).toEqual(ids);
  await moving(page);
  const retargeted = await card(page, ids[1]).evaluate((el) => {
    const animation = el.getAnimations()[0];
    animation.pause();
    animation.currentTime = 0;
    const y = el.getBoundingClientRect().y;
    animation.finish();
    return y;
  });
  expect(retargeted).toBeCloseTo(mid, 1);
  await settled(page);
  await sameNodes(page);
  await expect(handle(page, ids[1])).toBeFocused();
  expect(
    await page.evaluate(() =>
      (window as any).__test.repo.snapshot.items.map((x: any) => x.markdown),
    ),
  ).toEqual(['first **exact**', 'tree source', 'last `exact`']);
});
test('delayed reorder never takes newer Search focus, typing, or animates another view', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(() => (window as any).__test.delayCheckpoint());
  await capture(page).fill('preserved **draft**');
  await handle(page, ids[1]).press('Meta+ArrowUp');
  await page.getByRole('searchbox').fill('exact');
  await page.evaluate(() => (window as any).__test.releaseCheckpoint());
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__test.repo.snapshot.items.map(
          (item: any) => item.position,
        ),
      ),
    )
    .toEqual([1, 0, 2]);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('exact');
  await expect(capture(page)).toHaveText('preserved **draft**');
  await settled(page);
  expect(
    await page.evaluate(() =>
      (window as any).__test.repo.snapshot.items.map((x: any) => x.position),
    ),
  ).toEqual([1, 0, 2]);
});
test('expanded inline editor geometry, caret, and Undo remain attached to exact ID through reorder', async ({
  page,
}) => {
  const long = Array.from(
    { length: 50 },
    (_, i) => `line ${i} **source**`,
  ).join('\n\n');
  const ids = await seed(page, ['short', long, 'last']);
  await card(page, ids[1]).getByRole('button', { name: 'Expand note' }).click();
  await card(page, ids[1]).dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await editor.press('End');
  await page.keyboard.type(' edit');
  await page.evaluate(() => (window as any).__test.controller.flush());
  const before = await card(page, ids[1]).locator('.note-body').boundingBox();
  // Keep the active editor and cached history while its own gutter issues reorder.
  await handle(page, ids[1]).press('Meta+ArrowUp');
  await expect.poll(() => order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await settled(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__test.controller.state.keyboardOrder,
      ),
    )
    .toBeNull();
  await card(page, ids[1]).dblclick();
  const after = await card(page, ids[1]).locator('.note-body').boundingBox();
  expect(after!.width).toBe(before!.width);
  expect(after!.height).toBe(before!.height);
  await editor.press('Meta+z');
  await expect
    .poll(() =>
      page.evaluate(
        (id) => (window as any).__test.controller.state.buffers[id].source,
        ids[1],
      ),
    )
    .toBe(long);
  await expect(
    card(page, ids[1]).getByRole('button', { name: 'Collapse note' }),
  ).toBeVisible();
});
test('existing nearest-item visibility scroll skips cosmetic motion and keeps final drag targets usable', async ({
  page,
}) => {
  const long = Array.from({ length: 40 }, (_, i) => `tall line ${i}`).join(
    '\n\n',
  );
  const ids = await seed(page, ['moving', long, long]);
  await card(page, ids[1]).getByRole('button', { name: 'Expand note' }).click();
  await card(page, ids[2]).getByRole('button', { name: 'Expand note' }).click();
  await page.setViewportSize({ width: 1400, height: 600 });
  await handle(page, ids[0]).press('Meta+ArrowDown');
  await expect.poll(() => order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await settled(page);
  expect(
    await page.locator('.note-stream').evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0);
  const bounds = (await handle(page, ids[0]).boundingBox())!,
    stream = (await page.locator('.note-stream').boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(stream.y);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(
    stream.y + stream.height + 1,
  );
  expect(
    await handle(page, ids[0]).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
});
test('destroy settles only owned positional effects and prevents pending movement from replaying', async ({
  page,
}) => {
  const ids = await seed(page);
  const result = await page.evaluate(async (ids) => {
    const path = '/src/lib/workspace/reorder-motion.ts';
    const { createReorderMotion } = await import(path);
    const stream = document.querySelector('.note-stream') as HTMLElement;
    const rows = Array.from(stream.querySelectorAll<HTMLElement>('.note-card'));
    const motion = createReorderMotion(() => stream);
    const unrelated = rows[0]
      .querySelector('.note-body')!
      .animate([{ opacity: 1 }, { opacity: 0.99 }], {
        duration: 10000,
        iterations: Infinity,
      });
    motion.reorder([ids[1], ids[0], ids[2]]);
    stream.insertBefore(rows[1], rows[0]);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const positional = rows.flatMap((row) => row.getAnimations());
    const before = positional.length;
    motion.destroy();
    const ownedSettled = positional.every(
      (animation) => animation.playState === 'idle',
    );
    const unrelatedRunning = unrelated.playState === 'running';
    const transforms = rows.map((row) => getComputedStyle(row).transform);
    // Destroying between capture and the scheduled frame also invalidates work.
    const pending = createReorderMotion(() => stream);
    pending.reorder(ids);
    stream.insertBefore(rows[0], rows[1]);
    pending.destroy();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const replayed = rows.some((row) => row.getAnimations().length > 0);
    unrelated.cancel();
    return { before, ownedSettled, unrelatedRunning, transforms, replayed };
  }, ids);
  expect(result.before).toBeGreaterThan(0);
  expect(result.ownedSettled).toBe(true);
  expect(result.unrelatedRunning).toBe(true);
  expect(result.transforms).toEqual(['none', 'none', 'none']);
  expect(result.replayed).toBe(false);
});
