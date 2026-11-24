import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { validateCloudBackup } from '../../src/lib/sync/backup';

test.each([
  ['small', 48, 24, 48],
  ['medium', 1200, 72, 48],
  ['medium-short', 1200, 72, 48],
  ['medium-long', 1200, 72, 48],
  ['medium-wide-root', 1200, 72, 624],
  ['large', 3000, 144, 48],
  ['very-large', 19000, 500, 48],
])(
  '%s is a restorable synthetic library of the documented size',
  (name, notes, trees, rootCards) => {
    const file = new URL(
      `../fixtures/library-backups/${name}.json.gz`,
      import.meta.url,
    );
    const backup = validateCloudBackup(
      gunzipSync(readFileSync(file)).toString('utf8'),
    );
    if ('code' in backup) throw new Error(backup.message);

    const items = backup.library.items;
    expect(items.filter((item) => item.kind === 'note')).toHaveLength(notes);
    expect(items.filter((item) => item.kind === 'tree')).toHaveLength(trees);
    expect(items.filter((item) => item.parentId === null)).toHaveLength(
      rootCards,
    );
    expect(items.every((item) => item.deletedAt === null)).toBe(true);
    expect(backup.library.purgedIds).toEqual([]);
    expect(backup.device).toEqual({
      drafts: [],
      undoDeleteIds: [],
      recovery: [],
    });
  },
);
