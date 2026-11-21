import { expect, test } from '@playwright/test';
import { item } from '../fixtures/items';

const filePath = '/src/lib/platform/browser-backup-files.ts';
const databasePath = '/src/lib/sync/database.ts';
const repositoryPath = '/src/lib/sync/repository.ts';

test('stages only bounded UTF-8 files and revokes replaced or disposed download URLs', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const result = await page.evaluate(
    async ({ filePath, databasePath }) => {
      const { createBrowserBackupFiles } = await import(filePath);
      const { ScratchtreeDatabase } = await import(databasePath);
      const db = new ScratchtreeDatabase({ name: 'browser-backup-adapter' });
      const files = createBrowserBackupFiles(db);
      try {
        const source = 'α 🪴\r\n- exact source  \r\n';
        await files.stageRestoreFile(new File([source], 'first.json'));
        const firstRead = await files.chooseRead();
        const secondRead = await files.chooseRead();
        const badUtf8 = new File(
          [new Uint8Array([0xc0, 0x80])],
          'invalid.json',
        );
        await files.stageRestoreFile(badUtf8);
        const invalid = await files.chooseRead().then(
          () => 'accepted',
          (error: Error) => error.message,
        );
        const tooBig = new File(
          [new Uint8Array(10 * 1024 * 1024 + 1)],
          'oversize.json',
        );
        let oversizedRead = false;
        tooBig.arrayBuffer = async () => {
          oversizedRead = true;
          return new ArrayBuffer(0);
        };
        await files.stageRestoreFile(tooBig);
        const oversized = await files.chooseRead().then(
          () => 'accepted',
          (error: Error) => error.message,
        );
        await files.stageRestoreFile(new File([source], 'cancelled.json'));
        files.discardRestoreFile();
        const discarded = await files.chooseRead();

        let url = '';
        const unsub = files.subscribe(
          ({ download }: { download: { url: string } | null }) => {
            url = download?.url ?? '';
          },
        );
        await files.chooseWrite(source);
        const firstUrl = url;
        const downloaded = await (await fetch(firstUrl)).text();
        await files.chooseWrite('new backup');
        const secondUrl = url;
        const oldRevoked = await fetch(firstUrl).then(
          () => false,
          () => true,
        );
        files.dispose();
        const latestRevoked = await fetch(secondUrl).then(
          () => false,
          () => true,
        );
        unsub();
        return {
          firstRead,
          secondRead,
          invalid,
          oversized,
          oversizedRead,
          discarded,
          downloaded,
          oldRevoked,
          latestRevoked,
        };
      } finally {
        files.dispose();
        await db.delete();
      }
    },
    { filePath, databasePath },
  );
  expect(result.firstRead).toBe('α 🪴\r\n- exact source  \r\n');
  expect(result.secondRead).toBeNull();
  expect(result.invalid).toContain('UTF-8');
  expect(result.oversized).toContain('10 MiB');
  expect(result.oversizedRead).toBe(false);
  expect(result.discarded).toBeNull();
  expect(result.downloaded).toBe('α 🪴\r\n- exact source  \r\n');
  expect(result.oldRevoked).toBe(true);
  expect(result.latestRevoked).toBe(true);
});

test('a failed browser safety save preserves the prior copy, notes, and active epoch', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const prior = item({
    id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    markdown: 'α 🪴 **prior**  \r\n',
  });
  const next = item({
    id: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
    markdown: 'replacement\r\n',
  });
  const result = await page.evaluate(
    async ({ filePath, databasePath, repositoryPath, prior, next }) => {
      const { createBrowserBackupFiles } = await import(filePath);
      const { ScratchtreeDatabase } = await import(databasePath);
      const { DexieRepository } = await import(repositoryPath);
      const name = 'browser-backup-safety';
      let db = new ScratchtreeDatabase({ name });
      let files = createBrowserBackupFiles(db);
      const repo = new DexieRepository(db, files, undefined, true);
      const stage = async (value: typeof prior) => {
        const text = JSON.stringify({
          format: 'scratchtree',
          version: 8,
          exportedAt: '2026-11-21T00:00:00.000Z',
          library: { items: [value], purgedIds: [] },
          device: { drafts: [], undoDeleteIds: [], recovery: [] },
        });
        await files.stageRestoreFile(new File([text], 'restore.json'));
        return repo.previewRestore();
      };
      try {
        await repo.loadWorkspace();
        const firstPreview = await stage(prior);
        await repo.confirmRestore(firstPreview.token, true);
        const successfulEpoch = await repo.getEpoch();
        const secondPreview = await stage(next);
        const failSafetyWrite = (_: unknown, key: string) => {
          if (key === 'browser-restore-safety') {
            throw new DOMException(
              'Synthetic storage quota failure',
              'QuotaExceededError',
            );
          }
        };
        db.device.hook('updating', failSafetyWrite);
        const failure = await repo
          .confirmRestore(secondPreview.token, true)
          .then(
            () => 'accepted',
            (error: Error) => error.message,
          );
        db.device.hook('updating').unsubscribe(failSafetyWrite);
        const afterFailure = await repo.loadWorkspace();
        const epochAfterFailure = await repo.getEpoch();
        let url = '';
        const readPrevious = async () => {
          const unsub = files.subscribe(
            ({ download }: { download: { url: string } | null }) => {
              url = download?.url ?? '';
            },
          );
          await files.preparePreviousNotesDownload();
          unsub();
          return (await (await fetch(url)).json()).library.items;
        };
        const previousAfterFailure = await readPrevious();
        const replaced = await repo.confirmRestore(secondPreview.token, true);
        files.dispose();
        repo.close();

        db = new ScratchtreeDatabase({ name });
        files = createBrowserBackupFiles(db);
        const previousAfterReopen = await readPrevious();
        return {
          warning: secondPreview.warning,
          successfulEpoch,
          failure,
          afterFailure,
          epochAfterFailure,
          previousAfterFailure,
          replaced,
          previousAfterReopen,
        };
      } finally {
        files.dispose();
        await db.delete();
      }
    },
    { filePath, databasePath, repositoryPath, prior, next },
  );
  expect(result.warning).toBe('This replaces the notes in this browser.');
  expect(result.failure).toContain('previous notes');
  expect(result.epochAfterFailure).toBe(result.successfulEpoch);
  expect(result.afterFailure.items).toEqual([prior]);
  expect(result.previousAfterFailure).toEqual([]);
  expect(result.replaced.items).toEqual([next]);
  expect(result.previousAfterReopen).toEqual([prior]);
});

test('an export during startup keeps the previous notes available without replacing the export', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const result = await page.evaluate(
    async ({ filePath, databasePath }) => {
      const { createBrowserBackupFiles } = await import(filePath);
      const { ScratchtreeDatabase } = await import(databasePath);
      const name = 'browser-backup-startup';
      let db = new ScratchtreeDatabase({ name });
      let files = createBrowserBackupFiles(db);
      try {
        await files.writeSafety('prior notes');
        files.dispose();
        db.close();
        db = new ScratchtreeDatabase({ name });
        files = createBrowserBackupFiles(db);

        let kind = '';
        let priorAvailable = false;
        files.subscribe(
          ({
            download,
            hasPreviousNotes,
          }: {
            download: { kind: string } | null;
            hasPreviousNotes: boolean;
          }) => {
            kind = download?.kind ?? '';
            priorAvailable = hasPreviousNotes;
          },
        );
        const preparing = files.preparePreviousNotesDownload();
        await files.chooseWrite('new export');
        await preparing;
        return { kind, priorAvailable };
      } finally {
        files.dispose();
        await db.delete();
      }
    },
    { filePath, databasePath },
  );
  expect(result).toEqual({ kind: 'backup', priorAvailable: true });
});
