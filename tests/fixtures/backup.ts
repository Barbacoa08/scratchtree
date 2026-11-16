import type { WorkspaceSnapshot } from '../../src/lib/domain/notes';
import type { BackupV8 } from '../../src/lib/sync/backup';
export { validateCloudBackup as validateBackup } from '../../src/lib/sync/backup';

/** Current synthetic envelope; intentionally permits malformed snapshot test inputs. */
export function backupFixture(
  snapshot: WorkspaceSnapshot,
  exportedAt = '2026-11-14T00:00:00.000Z',
): BackupV8 {
  return {
    format: 'scratchtree',
    version: 8,
    exportedAt,
    library: { items: snapshot.items, purgedIds: [] },
    device: {
      drafts: snapshot.drafts,
      undoDeleteIds: snapshot.undoDeleteIds,
      recovery: [],
    },
  };
}
export function encodeBackup(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify(backupFixture(snapshot));
}
