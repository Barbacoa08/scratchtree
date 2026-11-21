import { expect, test } from '@playwright/test';
import type { WorkspaceSnapshot } from '../../src/lib/domain/notes';

test('keyboard reorder through the normal workspace persists exact sibling order and leaves source, children, and drafts intact after reload', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'New note Markdown' });
  const stream = page.getByRole('region', { name: 'Note stream' });
  const order = () =>
    stream
      .locator('[data-entry-id]')
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-entry-id')),
      );
  await page.goto('/?fixture');
  await expect(composer).toBeVisible();
  const sample = await page.evaluate(async () => {
    const databasePath = '/src/lib/sync/database.ts';
    const repositoryPath = '/src/lib/sync/repository.ts';
    const { ScratchtreeDatabase } = await import(databasePath);
    const { DexieRepository } = await import(repositoryPath);
    const db = new ScratchtreeDatabase({ name: 'scratchtree-local-v8' });
    const repo = new DexieRepository(db, {});
    const rootIds: string[] = [];
    try {
      await repo.loadWorkspace();
      for (const markdown of [
        'One',
        'Two',
        'Three',
        'Four',
        '**Exact**\r\nsource',
      ]) {
        const id = crypto.randomUUID();
        rootIds.push(id);
        await repo.captureItem({
          id,
          location: { scope: 'live', itemId: null },
          markdown,
          draft: { key: 'compose', revision: 0 },
        });
      }
      await repo.promoteItem(rootIds[1]);
      await repo.captureItem({
        id: crypto.randomUUID(),
        location: { scope: 'live', itemId: rootIds[1] },
        markdown: 'Exact child',
        draft: { key: `compose:${rootIds[1]}`, revision: 0 },
      });
      const before = await repo.checkpointDraft(
        'compose',
        '**Exact draft**',
        1,
      );
      return { rootIds, before } as {
        rootIds: string[];
        before: WorkspaceSnapshot;
      };
    } finally {
      db.close();
    }
  });

  await page.goto('/');
  await expect(composer).toBeVisible();
  expect(await order()).toEqual(sample.rootIds);
  const [one, two, three, four, five] = sample.rootIds;
  await stream.locator(`[data-entry-id="${five}"]`).click();
  await page.keyboard.down('Meta');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.up('Meta');
  await expect.poll(order).toEqual([one, two, five, three, four]);
  await expect(
    page.getByRole('status').filter({ hasText: 'Order updated' }),
  ).toBeVisible();

  await page.reload();
  await expect(composer).toHaveText('**Exact draft**');
  await expect.poll(order).toEqual([one, two, five, three, four]);
  const saved = await page.evaluate(async () => {
    const databasePath = '/src/lib/sync/database.ts';
    const repositoryPath = '/src/lib/sync/repository.ts';
    const { ScratchtreeDatabase } = await import(databasePath);
    const { DexieRepository } = await import(repositoryPath);
    const db = new ScratchtreeDatabase({ name: 'scratchtree-local-v8' });
    const repo = new DexieRepository(db, {});
    try {
      return {
        snapshot: (await repo.loadWorkspace()) as WorkspaceSnapshot,
        pending: await db.pending.count(),
      };
    } finally {
      db.close();
    }
  });
  expect(saved.pending).toBe(0);
  expect(saved.snapshot.items.find((item) => item.parentId === two)).toEqual(
    sample.before.items.find((item) => item.parentId === two),
  );
  expect(saved.snapshot.drafts).toEqual(sample.before.drafts);
  expect(saved.snapshot.items.find((item) => item.id === five)?.markdown).toBe(
    '**Exact**\r\nsource',
  );
});

test('reorder reconciliation leaves same-ID epoch adoption and editor reset to controller refresh', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(
    page.getByRole('textbox', { name: 'New note Markdown' }),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const databasePath = '/src/lib/sync/database.ts';
    const repositoryPath = '/src/lib/sync/repository.ts';
    const backupPath = '/src/lib/sync/backup.ts';
    const controllerPath = '/src/lib/workspace/controller.ts';
    const { ScratchtreeDatabase } = await import(databasePath);
    const { DexieRepository } = await import(repositoryPath);
    const { encodeCloudBackup } = await import(backupPath);
    const { WorkspaceController } = await import(controllerPath);
    const name = `keyboard-reorder-replacement-${crypto.randomUUID()}`;
    const db = new ScratchtreeDatabase({ name });
    const replacingDb = new ScratchtreeDatabase({ name });
    let restoreText: string | null = null;
    const files = {
      chooseRead: async () => restoreText,
      chooseWrite: async () => null,
      writeSafety: async () => {},
    };
    const repo = new DexieRepository(db, files);
    const other = new DexieRepository(replacingDb, files);
    const controller = new WorkspaceController(repo);
    try {
      await repo.loadWorkspace();
      const edited = crypto.randomUUID();
      await repo.captureItem({
        id: edited,
        location: { scope: 'live', itemId: null },
        markdown: 'Old editor source',
        draft: { key: 'compose', revision: 0 },
      });
      await controller.start();
      const capture = repo.captureItem.bind(repo);
      const captureRequests: string[] = [];
      repo.captureItem = async (request: { id: string }) => {
        captureRequests.push(request.id);
        const saved = await capture(request);
        if (captureRequests.length === 1)
          throw Error('Synthetic lost creation acknowledgment');
        return saved;
      };
      controller.editSource('Exact pending creation');
      const lostCapture = await controller.save();
      await controller.flush();
      await controller.refreshFromRepository();
      await controller.selectNote(edited);
      const before = (await other.loadWorkspace()) as WorkspaceSnapshot;
      const beforeOrder = [...before.items]
        .sort((a, b) => a.position - b.position)
        .map((item) => item.id);
      const beforeGeneration = controller.state.cacheGeneration;
      const beforeEpoch = repo.viewEpoch;
      const replacement = structuredClone(before);
      replacement.items.find((item) => item.id === edited)!.markdown =
        'Replacement editor source';
      restoreText = encodeCloudBackup({
        library: { items: replacement.items, purgedIds: [] },
        device: { drafts: [], undoDeleteIds: [], recovery: [] },
      });
      const preview = await other.previewRestore();
      const load = repo.loadWorkspace.bind(repo);
      let replacementDuringRead = false;
      repo.loadWorkspace = async (...args: unknown[]) => {
        replacementDuringRead = true;
        await other.confirmRestore(preview.token, true);
        return load(...args);
      };
      const moved = controller.stageKeyboardReorder(
        [edited],
        beforeOrder,
        1,
        async () => {},
      );
      const barrier = await controller.flush();
      const epochPreserved = repo.viewEpoch === beforeEpoch;
      await controller.refreshFromRepository();
      const after = {
        generation: controller.state.cacheGeneration,
        activeKey: controller.state.activeKey,
        markdown: controller.sourceFor(edited),
        order: [
          ...(controller.state.snapshot.items as WorkspaceSnapshot['items']),
        ]
          .sort((a, b) => a.position - b.position)
          .map((item) => item.id),
      };
      await controller.newNote();
      controller.editSource('New creation after replacement');
      const newCapture = await controller.save();
      return {
        lostCapture,
        replacementDuringRead,
        moved,
        barrier,
        epochPreserved,
        generationChanged: after.generation > beforeGeneration,
        activeComposer: after.activeKey === 'compose',
        replacementSource: after.markdown,
        orderUnchanged:
          JSON.stringify(after.order) === JSON.stringify(beforeOrder),
        newCapture,
        capturedExactlyOnceInEachEpoch:
          captureRequests.length === 2 &&
          captureRequests[0] !== captureRequests[1],
      };
    } finally {
      controller.dispose();
      db.close();
      replacingDb.close();
    }
  });
  expect(result).toEqual({
    lostCapture: false,
    replacementDuringRead: true,
    moved: true,
    barrier: false,
    epochPreserved: true,
    generationChanged: true,
    activeComposer: true,
    replacementSource: 'Replacement editor source',
    orderUnchanged: true,
    newCapture: true,
    capturedExactlyOnceInEachEpoch: true,
  });
});
