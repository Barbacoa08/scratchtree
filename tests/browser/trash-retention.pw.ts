import { expect, test } from '@playwright/test';

test('restored Trash keeps its age and startup purges only eligible local notes', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const results = await page.evaluate(async () => {
    const databasePath = '/src/lib/sync/database.ts';
    const repositoryPath = '/src/lib/sync/repository.ts';
    const backupFilesPath = '/src/lib/platform/browser-backup-files.ts';
    const { ScratchtreeDatabase } = await import(databasePath);
    const { DexieRepository } = await import(repositoryPath);
    const { createBrowserBackupFiles } = await import(backupFilesPath);
    const day = 86_400_000;
    const now = Date.now();
    const id = (end: number) => `00000000-0000-4000-8000-00000000000${end}`;
    const note = (end: number, deletedAt: number | null, position: number) => ({
      id: id(end),
      kind: 'note',
      parentId: null,
      markdown: `Synthetic note ${end}`,
      position,
      deletedAt,
      createdAt: now - 240 * day,
      updatedAt: now - day,
      done: false,
      color: null,
      restoreParentId: null,
      restoreIndex: null,
    });
    const name = 'local-trash-retention';
    const db = new ScratchtreeDatabase({ name });
    const files = createBrowserBackupFiles(db);
    const repository = new DexieRepository(db, files, undefined, true);
    const text = JSON.stringify({
      format: 'scratchtree',
      version: 8,
      exportedAt: new Date(now).toISOString(),
      library: {
        items: [
          note(1, now - 181 * day, 0),
          {
            ...note(2, now - 10 * day, 1),
            restoreParentId: id(1),
            restoreIndex: 3,
          },
          note(3, null, 0),
          note(4, now - 183 * day, 2),
        ],
        purgedIds: [],
      },
      device: {
        drafts: [
          {
            key: id(4),
            markdown: 'Keep this draft',
            revision: 1,
            updatedAt: now,
          },
        ],
        undoDeleteIds: [id(1), id(2)],
        recovery: [],
      },
    });
    await repository.loadWorkspace();
    await files.stageRestoreFile(new File([text], 'restore.json'));
    const preview = await repository.previewRestore();
    await repository.confirmRestore(preview.token, true);
    files.dispose();
    repository.close();

    const reopened = new ScratchtreeDatabase({ name });
    const nextFiles = createBrowserBackupFiles(reopened);
    const next = new DexieRepository(reopened, nextFiles, undefined, true);
    try {
      return {
        warning: preview.warning,
        snapshot: await next.loadWorkspace(),
        rawNoteIds: (await reopened.notes.toArray()).map(
          ({ id }: { id: string }) => id,
        ),
        purgedIds: (await reopened.purges.toArray()).map(
          ({ id }: { id: string }) => id,
        ),
      };
    } finally {
      nextFiles.dispose();
      next.close();
    }
  });
  const expected = (end: number) => `00000000-0000-4000-8000-00000000000${end}`;
  expect(results.warning).toContain('Imported Trash older than 180 days');
  expect(
    results.snapshot.items.map(
      ({ id, position }: { id: string; position: number }) => [id, position],
    ),
  ).toEqual([
    [expected(2), 0],
    [expected(3), 0],
    [expected(4), 1],
  ]);
  expect(results.snapshot.undoDeleteIds).toEqual([expected(2)]);
  expect(results.snapshot.items[0]).toMatchObject({
    restoreParentId: null,
    restoreIndex: 3,
  });
  expect(results.snapshot.drafts).toMatchObject([
    { key: expected(4), markdown: 'Keep this draft' },
  ]);
  expect(results.purgedIds).toEqual([expected(1)]);
  expect(results.rawNoteIds).toEqual([expected(2), expected(3), expected(4)]);
});
