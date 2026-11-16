import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { validateCloudBackup } from '../../src/lib/sync/backup';

test('workload command emits a strict current backup with the documented synthetic sizes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scratchtree-workload-'));
  try {
    const output = join(directory, 'synthetic.json');
    const message = execFileSync(
      process.execPath,
      ['scripts/generate-workload.mjs', output],
      { encoding: 'utf8' },
    );
    expect(message).toContain('999 × 1 KiB notes and one 128 KiB note');
    const backup = validateCloudBackup(readFileSync(output, 'utf8'));
    expect(backup).not.toHaveProperty('code');
    if ('code' in backup) throw new Error(backup.message);
    expect(backup.library.items).toHaveLength(1000);
    expect(backup.library.purgedIds).toEqual([]);
    expect(backup.device).toEqual({
      drafts: [],
      undoDeleteIds: [],
      recovery: [],
    });
    for (const [index, item] of backup.library.items.entries()) {
      expect(item.position).toBe(index);
      expect(item.parentId).toBeNull();
      expect(item.kind).toBe('note');
      expect(item.markdown).toMatch(/^Synthetic note \d{4} \*\*visible\*\*\n/);
      expect(Buffer.byteLength(item.markdown)).toBe(
        index === 999 ? 128 * 1024 : 1024,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
