import { expect, it } from 'vitest';
import { directEntries } from '../../src/lib/domain/hierarchy';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import { item } from '../fixtures/items';
import { MemoryRepository } from '../fixtures/memory';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const root = { scope: 'live', itemId: null } as const;
const destination = { scope: 'live', itemId: id(5) } as const;
const trash = { scope: 'trash', itemId: null } as const;

async function start() {
  const repo = new MemoryRepository();
  repo.snapshot.items = [1, 2, 3, 4, 5, 6].map((n) =>
    item({
      id: id(n),
      position: n === 6 ? 0 : n - 1,
      markdown: `Note ${n}`,
      ...(n === 5 ? { kind: 'tree' } : {}),
      ...(n === 6 ? { parentId: id(5) } : {}),
    }),
  );
  const controller = new WorkspaceController(repo);
  await controller.start();
  const order = (
    location = root as typeof root | typeof destination | typeof trash,
  ) => directEntries(repo.snapshot, location).map((entry) => entry.id);
  return { repo, controller, order };
}

it('undoes and redoes deletes, reorders, and a noncontiguous move in chronological order', async () => {
  const { controller: c, order } = await start();
  await c.moveItems(c.captureMove([id(1), id(3)], destination, 1));
  await c.reorderItem({ id: id(4), group: root, toIndex: 0 });
  await c.remove(id(2));
  await c.openLocation(destination);
  await c.undoRemove();
  expect(order()).toEqual([id(4), id(2), id(5)]);
  await c.undoRemove();
  expect(order()).toEqual([id(2), id(4), id(5)]);
  await c.undoRemove();
  expect(order()).toEqual([id(1), id(2), id(3), id(4), id(5)]);
  expect(order(destination)).toEqual([id(6)]);
  await c.redo();
  expect(order(destination)).toEqual([id(6), id(1), id(3)]);
  await c.redo();
  await c.redo();
  expect(order()).toEqual([id(4), id(5)]);
  expect(order(trash)).toEqual([id(2)]);
});

it('keeps only ten actions, discards the redo branch after a new action, and starts empty on reopen', async () => {
  const { repo, controller: c, order } = await start();
  for (let i = 0; i < 11; i++)
    await c.reorderItem({ id: id(1), group: root, toIndex: i % 2 ? 0 : 1 });
  for (let i = 0; i < 10; i++) expect(await c.undoRemove()).toBe(true);
  expect(await c.undoRemove()).toBe(false);
  expect(order()[1]).toBe(id(1));
  await c.remove(id(3));
  expect(await c.redo()).toBe(false);
  const reopened = new WorkspaceController(repo);
  await reopened.start();
  expect(await reopened.undoRemove()).toBe(false);
  expect(order(trash)).toEqual([id(3)]);
  expect(await reopened.restoreItem(id(3))).toBe(true);
});

it('restores a demoted origin with its exact note IDs and preserves newer content', async () => {
  const { repo, controller: c, order } = await start();
  await c.openLocation(destination);
  await c.moveItems(c.captureMove([id(6)], root, 0));
  await c.openLocation(root);
  expect(repo.snapshot.items.find((x) => x.id === id(5))?.kind).toBe('note');
  await repo.saveItemSource(id(6), 'New text\r\n', { key: id(6), revision: 1 });
  await c.undoRemove();
  expect(order(destination)).toEqual([id(6)]);
  expect(repo.snapshot.items.find((x) => x.id === id(5))?.kind).toBe('tree');
  expect(repo.snapshot.items.find((x) => x.id === id(6))?.markdown).toBe(
    'New text\r\n',
  );
});

it('never reverses newer sibling structure when the exact before state has changed', async () => {
  const { repo, controller: c, order } = await start();
  await c.moveItems(c.captureMove([id(3)], destination, 0));
  await repo.reorderItem({ id: id(6), group: destination, toIndex: 0 });
  expect(await c.undoRemove()).toBe(false);
  expect(order(destination)).toEqual([id(6), id(3)]);
  expect(c.state.error).toMatch(/changed/i);
});

it('does not acquire a Redo entry for a reversal another writer performed', async () => {
  const { repo, controller: c, order } = await start();
  await c.moveItems(c.captureMove([id(3)], destination, 0));
  await repo.moveItems(c.captureMove([id(3)], root, 2));
  expect(await c.undoRemove()).toBe(false);
  expect(await c.redo()).toBe(false);
  expect(order()).toEqual([id(1), id(2), id(3), id(4), id(5)]);
});

it('retries a lost history reply using the same request when Undo is pressed again', async () => {
  const { repo, controller: c, order } = await start();
  await c.remove(id(1));
  const apply = repo.applyHistory.bind(repo);
  const requests: string[] = [];
  repo.applyHistory = async (request) => {
    requests.push(request.id);
    const saved = await apply(request);
    if (requests.length === 1) throw new Error('Lost write reply');
    return saved;
  };
  expect(await c.undoRemove()).toBe(false);
  expect(await c.undoRemove()).toBe(true);
  expect(requests).toEqual([requests[0], requests[0]]);
  expect(order()).toEqual([id(1), id(2), id(3), id(4), id(5)]);
});

it('does not record a concurrent writer’s identical move or deletion as local history', async () => {
  const { repo, controller: c, order } = await start();
  const other = new WorkspaceController(repo);
  await other.start();
  const move = c.captureMove([id(3)], destination, 0);
  expect(
    await other.moveItems(other.captureMove([id(3)], destination, 0)),
  ).toBe(true);
  expect(await c.moveItems(move)).toBe(false);
  expect(await c.undoRemove()).toBe(false);
  await c.refreshFromRepository();
  expect(await other.remove(id(1))).toBe(true);
  expect(await c.remove(id(1))).toBe(false);
  expect(await c.undoRemove()).toBe(false);
  expect(order(destination)).toEqual([id(3), id(6)]);
  expect(order(trash)).toEqual([id(1)]);
});

it('can undo the first reorder after its dedicated storage retry succeeds', async () => {
  const { repo, controller: c, order } = await start();
  c.stageKeyboardReorder([id(3)], -1);
  repo.fail = 'move';
  expect(await c.undoRemove()).toBe(false);
  repo.fail = null;
  expect(await c.flush()).toBe(true);
  expect(await c.undoRemove()).toBe(true);
  expect(order()).toEqual([id(1), id(2), id(3), id(4), id(5)]);
});

it('settles a lost Undo before another structural command can advance the history', async () => {
  const { repo, controller: c, order } = await start();
  await c.reorderItem({ id: id(1), group: root, toIndex: 1 });
  await c.remove(id(3));
  expect(await c.undoRemove()).toBe(true);
  const apply = repo.applyHistory.bind(repo);
  let lose = true;
  repo.applyHistory = async (request) => {
    const saved = await apply(request);
    if (lose) {
      lose = false;
      throw new Error('Lost write reply');
    }
    return saved;
  };
  const pendingUndo = c.undoRemove();
  expect(await c.remove(id(4))).toBe(false);
  expect(await pendingUndo).toBe(false);
  expect(await c.redo()).toBe(false);
  expect(await c.remove(id(2))).toBe(false);
  expect(await c.retryMutation()).toBe(true);
  expect(order()).toEqual([id(1), id(2), id(3), id(4), id(5)]);
  expect(await c.redo()).toBe(true);
  expect(await c.redo()).toBe(true);
  expect(order(trash)).toEqual([id(3)]);
});

it('reverses a cross-area move without restoring separately deleted descendants', async () => {
  const { repo, controller: c } = await start();
  repo.snapshot.items.push(
    item({ id: id(7), kind: 'tree', deletedAt: 4 }),
    item({ id: id(8), parentId: id(7) }),
    item({ id: id(9), parentId: id(7), position: 1, deletedAt: 5 }),
  );
  await c.refreshFromRepository();
  const independent = () =>
    repo.snapshot.items.find((item) => item.id === id(9));
  expect(await c.moveItems(c.captureMove([id(7)], destination, 1))).toBe(true);
  expect(independent()).toMatchObject({ parentId: null, deletedAt: 5 });
  expect(await c.undoRemove()).toBe(true);
  expect(independent()).toMatchObject({ parentId: id(7), deletedAt: 5 });
  expect(await c.redo()).toBe(true);
  expect(independent()).toMatchObject({ parentId: null, deletedAt: 5 });
});

it('rejects a retried tree deletion when another writer adds a child', async () => {
  const { repo, controller: c, order } = await start();
  repo.fail = 'delete';
  expect(await c.remove(id(5))).toBe(false);
  repo.fail = null;
  await repo.captureItem({
    id: id(7),
    location: destination,
    markdown: 'New child',
    draft: { key: 'compose:' + id(5), revision: 0 },
  });
  expect(await c.retryMutation()).toBe(false);
  expect(order(destination)).toEqual([id(6), id(7)]);
  expect(order(trash)).toEqual([]);
});

it('does not strand a retry when Undo would restore a pointer to a purged note', async () => {
  const { repo, controller: c, order } = await start();
  repo.snapshot.items.push(
    item({ id: id(7), deletedAt: 5, restoreParentId: id(2), restoreIndex: 0 }),
  );
  await c.refreshFromRepository();
  expect(await c.moveItems(c.captureMove([id(7)], destination, 1))).toBe(true);
  await repo.deleteItem(id(2));
  await repo.purgeItem({
    id: id(2),
    location: trash,
    expectedSubtreeIds: [id(2)],
  });
  expect(await c.undoRemove()).toBe(false);
  expect(c.state.mutationRetry).toBe(false);
  expect(order(destination)).toEqual([id(6), id(7)]);
});

it('records an exact repeated move acknowledgment only once', async () => {
  const { controller: c, order } = await start();
  const move = c.captureMove([id(3)], destination, 0);
  expect(await c.moveItems(move)).toBe(true);
  expect(await c.moveItems(move)).toBe(true);
  expect(await c.undoRemove()).toBe(true);
  expect(await c.undoRemove()).toBe(false);
  expect(await c.redo()).toBe(true);
  expect(order(destination)).toEqual([id(3), id(6)]);
});
