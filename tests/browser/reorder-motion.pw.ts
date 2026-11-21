import { test, expect, type Page } from '@playwright/test';
const card = (p: Page, id: string) => p.locator(`[data-entry-id="${id}"]`);
const handle = (p: Page, id: string) =>
  card(p, id).getByRole('button', { name: 'Reorder note', exact: true });
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'New note Markdown' });
async function seed(
  p: Page,
  sources = ['first **exact**', 'tree source', 'last `exact`'],
  fixture = '/?fixture',
) {
  await p.setViewportSize({ width: 1400, height: 900 });
  await p.goto(fixture);
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
test('two distinct keyboard taps move the visible cards within 100 ms while the first save is held', async ({
  page,
}) => {
  const ids = await seed(page, ['One', 'Two', 'Three', 'Four', 'Five']);
  await card(page, ids[4]).click();
  await holdFirstMove(page);
  await page.evaluate((id) => {
    const t = (window as any).__test;
    const row = document.querySelector(`[data-entry-id="${id}"]`)!;
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'ArrowUp' || !event.metaKey || t.firstReorderMovement)
          return;
        const initialY = row.getBoundingClientRect().y;
        const start = performance.now();
        t.firstReorderMovement = new Promise<number>((resolve) => {
          function sample() {
            const elapsed = performance.now() - start;
            if (Math.abs(row.getBoundingClientRect().y - initialY) >= 2) {
              resolve(elapsed);
            } else if (elapsed >= 165) {
              resolve(elapsed);
            } else {
              requestAnimationFrame(sample);
            }
          }
          requestAnimationFrame(sample);
        });
      },
      { capture: true },
    );
  }, ids[4]);

  await page.keyboard.down('Meta');
  await page.keyboard.press('ArrowUp');
  const firstMovement = page.evaluate(
    () => (window as any).__test.firstReorderMovement,
  );
  await expect.poll(() => moves(page)).toHaveLength(1);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.up('Meta');

  const visibleBeforeAcknowledgment = await order(page);
  const latest = [ids[0], ids[1], ids[4], ids[2], ids[3]];
  expect.soft(await firstMovement).toBeLessThanOrEqual(100);
  expect.soft(visibleBeforeAcknowledgment).toEqual(latest);
  expect(await storedOrder(page)).toEqual(ids);

  await releaseMove(page);
  await expect.poll(() => storedOrder(page)).toEqual(latest);
  expect(await moves(page)).toHaveLength(2);
  await expect(page.locator('.note-stream')).toBeFocused();
  await expect(card(page, ids[4])).toHaveClass(/\bselected\b/);
});

async function holdFirstMove(page: Page, loseAcknowledgment = false) {
  await page.evaluate((loseAcknowledgment) => {
    const t = (window as any).__test;
    const move = t.repo.moveItems.bind(t.repo);
    t.heldMoves = [];
    t.repo.moveItems = async (request: unknown) => {
      t.heldMoves.push(request);
      if (t.heldMoves.length === 1) {
        await new Promise<void>((resolve) => {
          t.releaseReorder = resolve;
        });
        const saved = await move(request);
        if (loseAcknowledgment)
          throw Error('Synthetic lost reorder acknowledgment');
        return saved;
      }
      return move(request);
    };
  }, loseAcknowledgment);
}
const moves = (page: Page) =>
  page.evaluate(() => (window as any).__test.heldMoves);
const releaseMove = (page: Page) =>
  page.evaluate(() => (window as any).__test.releaseReorder());
const storedOrder = (page: Page) =>
  page.evaluate(() =>
    [...(window as any).__test.repo.snapshot.items]
      .filter((item) => item.parentId === null)
      .sort((left, right) => left.position - right.position)
      .map((item) => item.id),
  );

test('held keyboard reorder keeps only the latest follow-up order and close waits for it', async ({
  page,
}) => {
  const ids = await seed(
    page,
    ['One', 'Two', 'Three', 'Four', 'Five'],
    '/?fixture&lifecycle',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await holdFirstMove(page);
  await card(page, ids[4]).click();
  await page.keyboard.press('Meta+ArrowUp');
  await expect.poll(() => moves(page)).toHaveLength(1);
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.press('Meta+ArrowUp');
  const latest = [ids[0], ids[1], ids[4], ids[2], ids[3]];
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.closedAtOrder = null;
    void t.requestClose().then(() => {
      t.closedAtOrder = [...t.repo.snapshot.items]
        .sort((left, right) => left.position - right.position)
        .map((item) => item.id);
    });
  });
  expect.soft(await order(page)).toEqual(latest);
  expect(await active(page)).toBe(0);
  expect(await storedOrder(page)).toEqual(ids);
  expect(
    await page.evaluate(() => (window as any).__test.windowState.hidden),
  ).toBe(0);
  await releaseMove(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).__test.closedAtOrder))
    .toEqual(latest);
  expect(
    await page.evaluate(() => (window as any).__test.windowState.hidden),
  ).toBe(1);
  const requests = await moves(page);
  expect(requests.map((request: any) => request.afterTo)).toEqual([
    [ids[0], ids[1], ids[2], ids[4], ids[3]],
    latest,
  ]);
});

test('a close checkpoint prevents new keyboard reorder admission until close finishes', async ({
  page,
}) => {
  const ids = await seed(page, undefined, '/?fixture&lifecycle');
  await holdFirstMove(page);
  await card(page, ids[2]).click();
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.delayCheckpoint();
    t.controller.editContext('compose', 'draft while closing');
    void t.requestClose();
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.repo.checkpointCalls),
    )
    .toBe(1);
  await page.keyboard.press('Meta+ArrowUp');
  const visibleDuringClose = await order(page);
  await page.evaluate(() => (window as any).__test.releaseCheckpoint());
  await expect
    .poll(() => page.evaluate(() => (window as any).__test.windowState.hidden))
    .toBe(1);
  expect(visibleDuringClose).toEqual(ids);
  expect(await moves(page)).toHaveLength(0);
  expect(await storedOrder(page)).toEqual(ids);
});

test('Retry reorder cannot queue behind a close checkpoint that is already running', async ({
  page,
}) => {
  const ids = await seed(page, undefined, '/?fixture&lifecycle');
  await card(page, ids[2]).click();
  await page.evaluate(() => ((window as any).__test.repo.fail = 'move'));
  await page.keyboard.press('Meta+ArrowUp');
  const retry = page.getByRole('button', {
    name: 'Retry reorder',
    exact: true,
  });
  await expect(retry).toBeVisible();
  await holdFirstMove(page);
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.fail = null;
    t.delayCheckpoint();
    t.controller.editContext('compose', 'draft while retry waits');
    void t.requestClose();
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.repo.checkpointCalls),
    )
    .toBe(1);
  await retry.click();
  await page.evaluate(() => (window as any).__test.releaseCheckpoint());
  const recovery = page.getByRole('region', { name: 'Could not hide window' });
  await expect(recovery).toBeVisible();
  expect(await moves(page)).toHaveLength(0);
  expect(
    await page.evaluate(() => (window as any).__test.windowState.hidden),
  ).toBe(0);

  await recovery.getByRole('button', { name: 'Retry and hide' }).click();
  await expect.poll(() => moves(page)).toHaveLength(1);
  expect(
    await page.evaluate(() => (window as any).__test.windowState.hidden),
  ).toBe(0);
  await releaseMove(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).__test.windowState.hidden))
    .toBe(1);
  expect(await storedOrder(page)).toEqual([ids[0], ids[2], ids[1]]);
});

test('a failed keyboard reorder keeps its own Retry after navigation and explains a blocked backup', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.setViewportSize({ width: 900, height: 750 });
  await card(page, ids[2]).click();
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.controller.editContext('compose', 'checkpoint before reorder');
    t.repo.fail = 'checkpoint';
  });
  await page.keyboard.press('Meta+ArrowUp');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic local checkpoint failure',
  );
  const retry = page.getByRole('button', {
    name: 'Retry reorder',
    exact: true,
  });
  await expect(retry).toBeVisible();
  await expect
    .soft(page.getByRole('button', { name: 'Retry saving changes' }))
    .toHaveCount(0);
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Trash', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(retry).toBeVisible();

  await page
    .getByRole('button', { name: 'Export backup', exact: true })
    .click();
  await expect
    .soft(page.getByRole('alert'))
    .toContainText('Retry the keyboard reorder');
  expect(
    await page.evaluate(() => (window as any).__test.repo.exported),
  ).toBeNull();
  await retry.click();
  await expect.poll(() => storedOrder(page)).toEqual([ids[0], ids[2], ids[1]]);
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Trash', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('a lost first acknowledgment retries the exact write before saving the newest projected order', async ({
  page,
}) => {
  const ids = await seed(page, ['One', 'Two', 'Three', 'Four', 'Five']);
  await holdFirstMove(page, true);
  await handle(page, ids[4]).focus();
  await page.keyboard.press('Meta+ArrowUp');
  await expect.poll(() => moves(page)).toHaveLength(1);
  await page.keyboard.press('Meta+ArrowUp');
  expect
    .soft(await order(page))
    .toEqual([ids[0], ids[1], ids[4], ids[2], ids[3]]);
  await releaseMove(page);
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic lost reorder acknowledgment',
  );
  expect(await order(page)).toEqual(ids);
  await card(page, ids[0]).click();
  await page
    .getByRole('button', { name: 'Retry reorder', exact: true })
    .click();
  await expect
    .poll(() => storedOrder(page))
    .toEqual([ids[0], ids[1], ids[4], ids[2], ids[3]]);
  const requests = await moves(page);
  expect(requests).toHaveLength(3);
  expect(requests[1]).toEqual(requests[0]);
  await expect(card(page, ids[0])).toHaveClass(/\bselected\b/);
});

test('a late acknowledgment cannot overwrite a replacement or save the follow-up in a different epoch', async ({
  page,
}) => {
  const ids = await seed(page, ['One', 'Two', 'Three', 'Four', 'Five']);
  await page.evaluate(() => {
    const t = (window as any).__test;
    const move = t.repo.moveItems.bind(t.repo);
    t.heldMoves = [];
    t.repo.viewEpoch = 'old-library';
    t.replacement = structuredClone(t.repo.snapshot);
    t.replacement.items[4].markdown = 'Replacement source';
    t.repo.moveItems = async (request: unknown) => {
      t.heldMoves.push(request);
      const oldAcknowledgment = await move(request);
      if (t.heldMoves.length === 1) {
        await new Promise<void>((resolve) => {
          t.releaseReorder = resolve;
        });
      }
      return oldAcknowledgment;
    };
  });
  await card(page, ids[4]).click();
  await page.keyboard.press('Meta+ArrowUp');
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).__test.releaseReorder),
    )
    .toBe('function');
  await page.keyboard.press('Meta+ArrowUp');
  expect(await order(page)).toEqual([ids[0], ids[1], ids[4], ids[2], ids[3]]);
  await page.getByRole('searchbox').fill('Replacement');
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.viewEpoch = 'new-library';
    // Include the first move in the replacement so an unguarded coalesced
    // request could otherwise pass its exact structural proof there.
    t.replacement.items[3].position = 4;
    t.replacement.items[4].position = 3;
    void t.remoteReplace(t.replacement);
    t.releaseReorder();
  });
  await expect(card(page, ids[4])).toContainText('Replacement source');
  expect(await moves(page)).toHaveLength(1);
  expect(await storedOrder(page)).toEqual([
    ids[0],
    ids[1],
    ids[2],
    ids[4],
    ids[3],
  ]);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Retry reorder' })).toHaveCount(
    0,
  );
});

// Catches premature persistence, absent cosmetic movement, overshoot, identity loss,
// scroll additions, and source/rank changes beyond the authoritative reorder.
test('keyboard reorder animates the same keyed cards before saving without changing source or viewport', async ({
  page,
}) => {
  const ids = await seed(page);
  await saveNodes(page);
  const before = await page.evaluate(() =>
    structuredClone((window as any).__test.repo.snapshot),
  );
  const y0 = (await card(page, ids[1]).boundingBox())!.y;
  const destinationY = (await card(page, ids[0]).boundingBox())!.y;
  await holdFirstMove(page);
  await handle(page, ids[1]).focus();
  await page.keyboard.press('Meta+ArrowUp');
  await expect.poll(() => moves(page)).toHaveLength(1);
  expect(await order(page)).toEqual([ids[1], ids[0], ids[2]]);
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
  await releaseMove(page);
  await expect.poll(() => storedOrder(page)).toEqual([ids[1], ids[0], ids[2]]);
  await settled(page);
  await sameNodes(page);
  await expect(handle(page, ids[1])).toBeFocused();
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
test('failed, boundary, source, membership, and search updates create no reorder animation', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'move';
  });
  await handle(page, ids[0]).press('Meta+ArrowDown');
  await expect(page.getByRole('alert')).toContainText('failure');
  expect(await order(page)).toEqual(ids);
  await settled(page);
  await handle(page, ids[0]).press('Meta+ArrowUp');
  await settled(page);
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    t.repo.fail = null;
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
      page.evaluate(() => (window as any).__test.controller.state.operation),
    )
    .toBeNull();
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
