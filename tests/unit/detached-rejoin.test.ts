import { describe, expect, it } from 'vitest';
import { planRejoin, reconcileTransfer } from '../../src/lib/sync/rejoin';
import { MAX_SOURCE, type Item } from '../../src/lib/domain/notes';
import { encodeCloudBackup } from '../../src/lib/sync/backup';
import type { Transfer } from '../../src/lib/sync/detached';
import type { PendingIntent } from '../../src/lib/sync/intents';
import { classifyOutcome } from '../../src/lib/sync/confirmation';
const id = '00000000-0000-4000-8000-000000000001';
const item: Item = {
  id,
  kind: 'note',
  parentId: null,
  position: 0,
  markdown: 'original',
  color: null,
  done: false,
  deletedAt: null,
  restoreParentId: null,
  restoreIndex: null,
  createdAt: 1,
  updatedAt: 2,
};
const lib = (...items: Item[]) => ({ items, purgedIds: [] as string[] });
const base = lib(item);
function field(
  kind: 'saveItemSource' | 'setItemDone',
  sequence: number,
): PendingIntent {
  const command =
    kind === 'saveItemSource'
      ? { kind, id, markdown: 'local', draft: { key: id, revision: 1 } }
      : { kind, id, done: true };
  return {
    epoch: 'same',
    command,
    id: crypto.randomUUID(),
    recordedAt: 10 + sequence,
    sequence,
    localApplied: true,
    fingerprint: '',
    digest: '',
    expected: {
      items: [
        {
          id,
          kind: 'update',
          digest: '',
          structural: item,
          fields: {
            updatedAt: { before: 2, after: 10 + sequence },
            ...(kind === 'setItemDone'
              ? { done: { before: false, after: true } }
              : {}),
          },
        },
      ],
      purgedIds: [],
      orders: [],
    },
  };
}
describe('same-epoch detached branches', () => {
  it('retains a conflicting source while replaying the independent completion with its original identity and time', () => {
    const source = field('saveItemSource', 1),
      done = field('setItemDone', 2);
    const result = planRejoin(
      base,
      lib({ ...item, markdown: 'local', done: true, updatedAt: 12 }),
      lib({ ...item, markdown: 'another Mac' }),
      [source, done],
    );
    expect(result.library.items[0]).toMatchObject({
      markdown: 'another Mac',
      done: true,
      updatedAt: 12,
    });
    expect(result.admitted.map((p) => p.id)).toEqual([done.id]);
    expect(result.conflicts.map((p) => p.id)).toEqual([source.id]);
  });
  it('never overwrites new remote source when the detached field returned to its baseline', () => {
    const first = field('saveItemSource', 1),
      last = field('saveItemSource', 2);
    if (last.command.kind === 'saveItemSource')
      last.command.markdown = 'original';
    const result = planRejoin(base, base, lib({ ...item, markdown: 'cloud' }), [
      first,
      last,
    ]);
    expect(result.library.items[0].markdown).toBe('cloud');
    expect(result.admitted).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });
});
it('emits a completion group witness only for an exact whole-group rejoin', async () => {
  const other = {
    ...item,
    id: '00000000-0000-4000-8000-000000000002',
    position: 1,
  };
  const before = lib(item, other);
  const group = field('setItemDone', 1);
  group.command = {
    kind: 'setItemsDone',
    ids: [item.id, other.id],
    done: true,
  };
  const completion = group.expected.items[0];
  if (completion.kind !== 'update')
    throw new Error('Expected completion delta');
  group.expected.items.push({ ...completion, id: other.id, structural: other });
  const complete = lib({ ...item, done: true }, { ...other, done: true });
  const matching = planRejoin(before, complete, before, [group]);
  expect(matching.admitted).toEqual([group]);
  expect(
    await classifyOutcome(
      group,
      {
        id: group.id,
        digest: group.digest,
        epoch: group.epoch,
        recordedAt: group.recordedAt,
      },
      { ...matching.library, epoch: group.epoch },
    ),
  ).toBe('matching');

  const reversal = field('setItemDone', 2);
  reversal.command = { kind: 'setItemDone', id, done: false };
  const outcome = reversal.expected.items[0];
  if (outcome.kind === 'update')
    outcome.fields.done = { before: true, after: false };
  const revised = planRejoin(
    before,
    lib(item, { ...other, done: true }),
    before,
    [group, reversal],
  );
  expect(revised.admitted).toEqual([]);
  expect(revised.conflicts).toEqual([group]);
  expect(revised.library).toEqual(before);

  const unchangedMember = { ...item, done: true };
  group.expected.items.shift();
  const noOpConflict = planRejoin(
    lib(unchangedMember, other),
    complete,
    before,
    [group],
  );
  expect(noOpConflict.admitted).toEqual([]);
  expect(noOpConflict.conflicts).toEqual([group]);
  expect(noOpConflict.library).toEqual(before);
  const zeroWrite = lib(item, { ...other, done: true });
  const zeroWriteConflict = planRejoin(
    lib(unchangedMember, other),
    complete,
    zeroWrite,
    [group],
  );
  expect(zeroWriteConflict.admitted).toEqual([]);
  expect(zeroWriteConflict.conflicts).toEqual([group]);
  expect(zeroWriteConflict.library).toEqual(zeroWrite);
});

it('refuses an old purge if the Trash tree gained a new child', () => {
  const trash = {
    ...item,
    kind: 'tree' as const,
    deletedAt: 3,
    restoreIndex: 0,
  };
  const child = {
    ...item,
    id: '00000000-0000-4000-8000-000000000002',
    parentId: id,
  };
  const purge: PendingIntent = {
    ...field('setItemDone', 1),
    command: {
      kind: 'purgeItem',
      request: {
        id,
        expectedSubtreeIds: [id],
        location: { scope: 'trash', itemId: null },
      },
    },
    expected: {
      items: [
        { kind: 'purge', id, before: trash, structural: null, digest: '' },
      ],
      purgedIds: [id],
      orders: [],
    },
  };
  const result = planRejoin(
    lib(trash),
    { items: [], purgedIds: [id] },
    lib(trash, child),
    [purge],
  );
  expect(result.library.items).toHaveLength(2);
  expect(result.conflicts.map((x) => x.id)).toEqual([purge.id]);
});

it('does not attach a child or metadata to a conflicting same-ID remote creation', () => {
  const parent = crypto.randomUUID(),
    child = crypto.randomUUID(),
    make = (
      id: string,
      parentId: string | null,
      seq: number,
      kind: 'note' | 'tree',
      markdown: string,
    ): PendingIntent => {
      const created = {
        ...item,
        id,
        parentId,
        kind,
        markdown,
        createdAt: seq,
        updatedAt: seq,
        position: 0,
      };
      return {
        ...field('setItemDone', seq),
        command: {
          kind: 'captureItem',
          request: {
            id,
            location: { scope: 'live', itemId: parentId },
            markdown,
            draft: { key: 'compose', revision: 0 },
          },
        },
        expected: {
          items: [
            {
              kind: 'create',
              id,
              structural: created,
              item: created,
              digest: '',
            },
          ],
          orders: [],
          purgedIds: [],
        },
      };
    };
  const a = make(parent, null, 1, 'tree', 'local parent'),
    b = make(child, parent, 2, 'note', 'child');
  const existing = {
    ...item,
    id: parent,
    kind: 'tree' as const,
    markdown: 'different',
  };
  const local = lib(
    { ...existing, markdown: 'local parent' },
    { ...item, id: child, parentId: parent, markdown: 'child' },
  );
  const result = planRejoin(lib(), local, lib(existing), [a, b]);
  expect(result.library.items).toEqual([existing]);
  expect(result.conflicts.map((p) => p.id)).toEqual([a.id, b.id]);
});

describe('first sign-in merge', () => {
  const account = 'a'.repeat(64);
  const childId = '00000000-0000-4000-8000-000000000002';

  function transfer(epoch: string, items: Item[]): Transfer {
    const backup: Transfer['backup'] = {
      format: 'scratchtree',
      version: 8,
      exportedAt: new Date(0).toISOString(),
      library: lib(...items),
      device: { drafts: [], undoDeleteIds: [], recovery: [] },
    };
    encodeCloudBackup(backup);
    return {
      epoch,
      backup,
      purges: [],
      archived: [],
      pending: [],
      journal: { sequence: 0, sources: [] },
    };
  }

  it('rejects a cycle assembled from two valid trees without changing either tree', () => {
    const local = transfer('local', [
      { ...item, parentId: childId, updatedAt: 4 },
      { ...item, id: childId, kind: 'tree' },
    ]);
    const synced = transfer('synced', [
      { ...item, kind: 'tree' },
      { ...item, id: childId, parentId: id, updatedAt: 5 },
    ]);
    const before = structuredClone([local, synced]);

    expect(() => reconcileTransfer(local, synced, null, account)).toThrow(
      /note hierarchies conflict/,
    );
    expect([local, synced]).toEqual(before);
  });

  it('keeps an independently deleted child in Trash when a newer parent is restored', () => {
    const local = transfer('local', [
      { ...item, kind: 'tree', deletedAt: 3, restoreIndex: 0, updatedAt: 3 },
      {
        ...item,
        id: childId,
        parentId: id,
        deletedAt: 4,
        restoreParentId: id,
        restoreIndex: 0,
        updatedAt: 4,
      },
    ]);
    const synced = transfer('synced', [
      { ...item, kind: 'tree', updatedAt: 5 },
    ]);
    local.backup.device.undoDeleteIds = [childId];

    const result = reconcileTransfer(local, synced, null, account).transfer;
    expect(result.backup.library.items).toEqual([
      { ...item, kind: 'tree', updatedAt: 5 },
      { ...local.backup.library.items[1], parentId: null },
    ]);
    expect(result.backup.device.undoDeleteIds).toEqual([childId]);
  });

  it('rejects the combined envelope when two valid libraries exceed its capacity', () => {
    const markdown = 'x'.repeat(MAX_SOURCE);
    const notes = () =>
      Array.from({ length: 6 }, (_, position) => ({
        ...item,
        id: crypto.randomUUID(),
        markdown,
        position,
      }));
    const local = transfer('local', notes());
    const synced = transfer('synced', notes());
    const before = structuredClone([local, synced]);

    expect(() => reconcileTransfer(local, synced, null, account)).toThrow(
      /10 MiB capacity/,
    );
    expect([local, synced]).toEqual(before);
  });
});
