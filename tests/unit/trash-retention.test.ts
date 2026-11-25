import { expect, it } from 'vitest';
import type { Item } from '../../src/lib/domain/notes';
import { expiredTrashIds } from '../../src/lib/domain/trash-retention';

const day = 86_400_000;
const now = 220 * day;
function item(id: string, values: Partial<Item> = {}): Item {
  return {
    id,
    parentId: null,
    kind: 'note',
    markdown: 'Synthetic note',
    done: false,
    color: null,
    createdAt: day,
    updatedAt: day,
    position: 0,
    deletedAt: null,
    restoreParentId: null,
    restoreIndex: null,
    ...values,
  };
}

it('expires only Trash older than 180 complete days, regardless of last edit', () => {
  expect(
    expiredTrashIds(
      [
        item('live'),
        item('boundary', { deletedAt: 40 * day }),
        item('old', { deletedAt: 40 * day - 1, updatedAt: 219 * day }),
        item('retrashed', { deletedAt: 210 * day }),
      ],
      now,
    ),
  ).toEqual(['old']);
});

it('inherits age through a subtree and puts descendants before their ancestors', () => {
  expect(
    expiredTrashIds(
      [
        item('root', { kind: 'tree', deletedAt: 5 * day }),
        item('child', { kind: 'tree', parentId: 'root' }),
        item('grandchild', { parentId: 'child' }),
        item('detached', { deletedAt: 215 * day, restoreParentId: 'root' }),
      ],
      now,
    ),
  ).toEqual(['grandchild', 'child', 'root']);
});

it.each([
  { deletedAt: 215 * day },
  { createdAt: 215 * day, updatedAt: 215 * day },
])('keeps ancestors of a younger descendant in Trash', (young) => {
  expect(
    expiredTrashIds(
      [
        item('old-tree', { kind: 'tree', deletedAt: 2 * day }),
        item('branch', { kind: 'tree', parentId: 'old-tree' }),
        item('young', { parentId: 'branch', ...young }),
      ],
      now,
    ),
  ).toEqual([]);
});

it('protects pending local input and its ancestors', () => {
  expect(
    expiredTrashIds(
      [
        item('tree', { kind: 'tree', deletedAt: 2 * day }),
        item('draft-owner', { parentId: 'tree' }),
        item('unrelated', { deletedAt: 2 * day }),
      ],
      now,
      new Set(['draft-owner']),
    ),
  ).toEqual(['unrelated']);
});
