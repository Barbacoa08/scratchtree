import { ScratchtreeDatabase } from '../sync/database';
import { readActivation } from '../sync/detached';
import { DexieRepository } from '../sync/repository';
import {
  createBrowserBackupFiles,
  type BrowserBackupFiles,
} from './browser-backup-files';
import { verifyWebPageRelease } from './browser-offline';

export interface WebWorkspace {
  repository: DexieRepository;
  backup: BrowserBackupFiles;
  close(): void;
}

export const reorderPreview =
  import.meta.env.VITE_SCRATCHTREE_REORDER_PREVIEW === '1';

function acquireEditor(signal: AbortSignal): Promise<(() => void) | null> {
  if (!navigator.locks)
    throw Error('This browser cannot safely open the local editor.');
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(
        reorderPreview
          ? 'scratchtree-reorder-preview'
          : 'scratchtree-local-editor',
        { ifAvailable: true },
        (lock) => {
          signal.throwIfAborted();
          if (!lock) {
            resolve(null);
            return;
          }
          return new Promise<void>((release) => resolve(release));
        },
      )
      .catch(reject);
  });
}

export async function openWebWorkspace(
  signal: AbortSignal,
): Promise<WebWorkspace | null> {
  const release = await acquireEditor(signal);
  if (!release) return null;
  const db = new ScratchtreeDatabase({
    name: reorderPreview
      ? 'scratchtree-reorder-preview-v1'
      : 'scratchtree-local-v8',
  });
  try {
    await verifyWebPageRelease();
    signal.throwIfAborted();
    await db.open();
    const active = await readActivation(db);
    signal.throwIfAborted();
    if (active.mode !== 'local' || active.cleanupNeeded)
      throw Error(
        'This version cannot open the existing notes. Your data is still in this browser.',
      );
    if (reorderPreview) {
      const { seedReorderPreview } =
        await import('../../../tests/fixtures/reorder-preview');
      signal.throwIfAborted();
      await seedReorderPreview(db);
    }
    const backup = createBrowserBackupFiles(db);
    const repository = new DexieRepository(db, backup, undefined, true);
    await repository.settleLocalWrites();
    signal.throwIfAborted();
    return {
      repository,
      backup,
      close() {
        repository.close();
        backup.dispose();
        release();
      },
    };
  } catch (error) {
    db.close();
    release();
    throw error;
  }
}
