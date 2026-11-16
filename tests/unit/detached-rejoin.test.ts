import { describe, expect, it } from 'vitest';
import { planRejoin } from '../../src/lib/sync/rejoin';
import type { Item } from '../../src/lib/domain/notes';
import type { PendingIntent } from '../../src/lib/sync/intents';
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
