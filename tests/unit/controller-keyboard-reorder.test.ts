import { afterEach, describe, expect, it, vi } from 'vitest';
import { directEntries } from '../../src/lib/domain/hierarchy';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import { item } from '../fixtures/items';
import { MemoryRepository } from '../fixtures/memory';

const root = { scope: 'live', itemId: null } as const;
const ids = Array.from({ length: 5 }, (_, position) => {
  return `00000000-0000-4000-8000-00000000000${position}`;
});

async function setup() {
  vi.useFakeTimers();
  const repo = Object.assign(new MemoryRepository(), {
    viewEpoch: 'original-library',
  });
  repo.snapshot.items = ids.map((id, position) =>
    item({ id, position, markdown: `row **${position}**` }),
  );
  const controller = new WorkspaceController(repo);
  const move = vi.spyOn(repo, 'moveItems');
  await controller.start();
  return {
    controller,
    move,
    repo,
    saved: () => directEntries(repo.snapshot, root).map((item) => item.id),
    tap: (direction: -1 | 1, selected = [ids[4]]) =>
      controller.stageKeyboardReorder(selected, direction),
  };
}

afterEach(() => vi.useRealTimers());

describe('keyboard reorder debounce', () => {
  it('visibly stages each tap and commits once after 400 ms of quiet', async () => {
    const { controller, move, saved, tap } = await setup();
    const once = [ids[0], ids[1], ids[2], ids[4], ids[3]];
    const twice = [ids[0], ids[1], ids[4], ids[2], ids[3]];
    expect(tap(-1)).toEqual(once);
    expect(controller.state.keyboardOrder).toEqual(once);
    await vi.advanceTimersByTimeAsync(399);
    expect(move).not.toHaveBeenCalled();
    expect(tap(-1)).toEqual(twice);
    expect(controller.state.keyboardOrder).toEqual(twice);
    await vi.advanceTimersByTimeAsync(399);
    expect(move).not.toHaveBeenCalled();
    expect(saved()).toEqual(ids);
    await vi.advanceTimersByTimeAsync(1);
    expect(move).toHaveBeenCalledTimes(1);
    expect(saved()).toEqual(twice);
    expect(controller.state.keyboardOrder).toBeNull();
    controller.dispose();
  });

  it('dispatches at the oldest unsaved tap’s 1,000 ms deadline during a burst', async () => {
    const { controller, move, saved, tap } = await setup();
    tap(-1);
    await vi.advanceTimersByTimeAsync(300);
    tap(-1);
    await vi.advanceTimersByTimeAsync(300);
    tap(-1);
    await vi.advanceTimersByTimeAsync(300);
    tap(-1);
    await vi.advanceTimersByTimeAsync(99);
    expect(move).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(move).toHaveBeenCalledTimes(1);
    expect(saved()).toEqual([ids[4], ...ids.slice(0, 4)]);
    controller.dispose();
  });

  it('does not write a reversal to the saved order or extend a deadline for a boundary tap', async () => {
    const { controller, move, saved, tap } = await setup();
    tap(-1);
    await vi.advanceTimersByTimeAsync(100);
    expect(tap(1)).toEqual(ids);
    expect(controller.state.keyboardOrder).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tap(-1, [ids[0]])).toBeNull();
    expect(move).not.toHaveBeenCalled();
    tap(-1, [ids[1]]);
    await vi.advanceTimersByTimeAsync(399);
    expect(tap(-1, [ids[1]])).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(move).toHaveBeenCalledTimes(1);
    expect(saved()).toEqual([ids[1], ids[0], ...ids.slice(2)]);
    controller.dispose();
  });

  it('preserves a collected nonadjacent sibling block and closes the debounce on a flush', async () => {
    const { controller, move, saved, tap } = await setup();
    const expectOrder = [ids[1], ids[3], ids[0], ids[2], ids[4]];
    expect(tap(-1, [ids[1], ids[3]])).toEqual(expectOrder);
    expect(move).not.toHaveBeenCalled();
    expect(await controller.flush()).toBe(true);
    expect(saved()).toEqual(expectOrder);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(move).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('serializes a follow-up which has already reached its own quiet interval', async () => {
    const { controller, move, repo, saved, tap } = await setup();
    const write = MemoryRepository.prototype.moveItems.bind(repo);
    const first = Promise.withResolvers<void>();
    move.mockImplementationOnce(async (request) => {
      await first.promise;
      return write(request);
    });
    tap(-1);
    await vi.advanceTimersByTimeAsync(400);
    expect(move).toHaveBeenCalledTimes(1);
    tap(-1);
    await vi.advanceTimersByTimeAsync(400);
    const twice = [ids[0], ids[1], ids[4], ids[2], ids[3]];
    expect(controller.state.keyboardOrder).toEqual(twice);
    expect(move).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(move).toHaveBeenCalledTimes(2);
    expect(saved()).toEqual(twice);
    controller.dispose();
  });

  it('retains an exact request and newer visible input after a committed reply is lost', async () => {
    const { controller, move, repo, saved, tap } = await setup();
    const write = MemoryRepository.prototype.moveItems.bind(repo);
    const first = Promise.withResolvers<void>();
    move.mockImplementationOnce(async (request) => {
      await write(request);
      await first.promise;
      throw new Error('Synthetic lost acknowledgment');
    });
    tap(-1);
    await vi.advanceTimersByTimeAsync(400);
    const twice = tap(-1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.keyboardReorderError).toContain(
      'lost acknowledgment',
    );
    expect(controller.state.keyboardOrder).toEqual(twice);
    expect(await controller.flush()).toBe(true);
    expect(move).toHaveBeenCalledTimes(3);
    expect(move.mock.calls[1][0]).toEqual(move.mock.calls[0][0]);
    expect(saved()).toEqual(twice);
    expect(controller.state.keyboardReorderError).toBe('');
    controller.dispose();
  });

  it('drains before navigation and backup export without writing in the new scope', async () => {
    const { controller, move, repo, saved, tap } = await setup();
    const exported = vi.spyOn(repo, 'exportBackup').mockResolvedValue(null);
    tap(-1);
    expect(
      await controller.openLocation({ scope: 'trash', itemId: null }),
    ).toBe(true);
    expect(controller.state.location.scope).toBe('trash');
    expect(saved()).toEqual([ids[0], ids[1], ids[2], ids[4], ids[3]]);
    await controller.openLocation(root);
    tap(-1);
    expect(await controller.export()).toBe(true);
    expect(move.mock.invocationCallOrder.at(-1)).toBeLessThan(
      exported.mock.invocationCallOrder[0],
    );
    expect(saved()).toEqual([ids[0], ids[1], ids[4], ids[2], ids[3]]);
    controller.dispose();
  });

  it('cannot stage a departure reorder while navigation reconciles uncertain creation', async () => {
    const { controller, move, repo, saved, tap } = await setup();
    await repo.promoteItem(ids[0]);
    const child = '00000000-0000-4000-8000-000000000005';
    const destination = { scope: 'live', itemId: ids[0] } as const;
    await repo.captureItem({
      id: child,
      location: destination,
      markdown: 'inside the destination',
      draft: { key: `compose:${ids[0]}`, revision: 0 },
    });
    await controller.refreshFromRepository();
    controller.editSource('uncertain capture');
    vi.spyOn(repo, 'captureItem').mockRejectedValueOnce(
      new Error('Write unavailable'),
    );
    const load = vi.spyOn(repo, 'loadWorkspace');
    load.mockRejectedValueOnce(new Error('Cannot check the capture outcome'));
    expect(await controller.save()).toBe(false);

    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    load.mockImplementationOnce(async () => {
      reading.resolve();
      await release.promise;
      return structuredClone(repo.snapshot);
    });
    const navigation = controller.openLocation(destination);
    await reading.promise;
    const staged = tap(-1);
    release.resolve();
    expect(await navigation).toBe(true);
    expect(staged).toBeNull();
    expect(controller.state.location).toEqual(destination);
    expect(controller.state.keyboardOrder).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(move).not.toHaveBeenCalled();
    expect(saved()).toEqual(ids);
    controller.dispose();
  });

  it('checkpoints independent dirty input even when an unresolved reorder conflict blocks a flush', async () => {
    const { controller, move, repo, tap } = await setup();
    tap(-1);
    repo.snapshot.items[1].position = 2;
    repo.snapshot.items[2].position = 1;
    await controller.refreshFromRepository();
    expect(controller.state.keyboardReorderError).toContain('changed');
    controller.editSource('preserve this draft before hiding');
    expect(await controller.flush()).toBe(false);
    expect(repo.snapshot.drafts[0].markdown).toBe(
      'preserve this draft before hiding',
    );
    expect(move).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('requests an actual replacement refresh when the initial dirty checkpoint detects a new epoch', async () => {
    const { controller, move, repo, tap } = await setup();
    const replacement = structuredClone(repo.snapshot);
    replacement.items[0].markdown = 'replacement source';
    Object.assign(repo, {
      refreshFromRemote: async () => ({
        workspace: replacement,
        replaced: true,
        removedIds: [],
        originEpoch: repo.viewEpoch,
      }),
    });
    vi.spyOn(repo, 'checkpointDraft').mockRejectedValueOnce(
      Object.assign(new Error('The shared library was replaced.'), {
        code: 'library_replaced',
      }),
    );
    controller.editSource('retained source from the original epoch');
    tap(-1);
    expect(await controller.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.cacheGeneration).toBe(1);
    expect(controller.state.snapshot.items[0].markdown).toBe(
      'replacement source',
    );
    expect(controller.state.keyboardOrder).toBeNull();
    expect(controller.state.keyboardReorderError).toContain('replaced');
    expect(move).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('rejects a replacement binding with the same sibling IDs before dispatch', async () => {
    const { controller, move, repo, saved, tap } = await setup();
    tap(-1);
    repo.viewEpoch = 'replacement-library';
    await vi.advanceTimersByTimeAsync(400);
    expect(controller.state.keyboardOrder).toBeNull();
    expect(controller.state.keyboardReorderError).toContain('replaced');
    expect(move).not.toHaveBeenCalled();
    expect(saved()).toEqual(ids);
    controller.dispose();
  });

  it('does not publish a late result or dispatch its follow-up under a replacement binding', async () => {
    const { controller, move, repo, tap } = await setup();
    const reply = Promise.withResolvers<typeof repo.snapshot>();
    move.mockReturnValueOnce(reply.promise);
    tap(-1);
    await vi.advanceTimersByTimeAsync(400);
    const newer = tap(-1);
    expect(controller.state.keyboardOrder).toEqual(newer);
    const write = MemoryRepository.prototype.moveItems.bind(repo);
    const oldAcknowledgment = await write(move.mock.calls[0][0]);
    repo.viewEpoch = 'replacement-library';
    reply.resolve(oldAcknowledgment);
    await vi.advanceTimersByTimeAsync(1000);
    expect(move).toHaveBeenCalledTimes(1);
    expect(controller.state.keyboardOrder).toBeNull();
    expect(controller.state.keyboardReorderError).toContain('replaced');
    expect(
      directEntries(controller.state.snapshot, root).map((item) => item.id),
    ).toEqual(ids);
    controller.dispose();
  });

  it('clears a captured proof that became stale outside the visible sibling group', async () => {
    const { controller, move, repo, tap } = await setup();
    const write = MemoryRepository.prototype.moveItems.bind(repo);
    const parent = '00000000-0000-4000-8000-000000000005';
    const nested = '00000000-0000-4000-8000-000000000006';
    repo.snapshot.items.push(
      item({
        id: parent,
        kind: 'tree',
        position: 0,
        deletedAt: 10,
        restoreIndex: 0,
      }),
    );
    await controller.refreshFromRepository();
    move.mockImplementationOnce((request) => {
      repo.snapshot.items.push(item({ id: nested, parentId: parent }));
      return write(request);
    });
    tap(-1);
    await vi.advanceTimersByTimeAsync(400);
    expect(controller.state.keyboardOrder).toBeNull();
    expect(controller.state.keyboardReorderError).toContain('changed');
    expect(move).toHaveBeenCalledTimes(1);
    expect(
      controller.state.snapshot.items.some((entry) => entry.id === nested),
    ).toBe(true);
    controller.dispose();
  });

  it('fails an explicit flush when its dirty checkpoint invalidates the accepted reorder', async () => {
    const { controller, move, repo, tap } = await setup();
    const checkpoint = MemoryRepository.prototype.checkpointDraft.bind(repo);
    vi.spyOn(repo, 'checkpointDraft').mockImplementationOnce((...args) => {
      repo.snapshot.items[1].position = 2;
      repo.snapshot.items[2].position = 1;
      return checkpoint(...args);
    });
    controller.editSource('a draft that must survive');
    tap(-1);
    expect(await controller.flush()).toBe(false);
    expect(repo.snapshot.drafts[0].markdown).toBe('a draft that must survive');
    expect(controller.state.keyboardOrder).toBeNull();
    expect(controller.state.keyboardReorderError).toContain('changed');
    expect(move).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('settles remote sibling changes and replacement without retargeting accepted input', async () => {
    const { controller, move, repo, saved, tap } = await setup();
    tap(-1);
    repo.snapshot.items[1].position = 2;
    repo.snapshot.items[2].position = 1;
    await controller.refreshFromRepository();
    expect(controller.state.keyboardOrder).toBeNull();
    expect(controller.state.keyboardReorderError).toContain('changed');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(move).not.toHaveBeenCalled();
    expect(saved()).toEqual([ids[0], ids[2], ids[1], ids[3], ids[4]]);
    tap(-1);
    Object.assign(repo, {
      refreshFromRemote: async () => ({
        workspace: structuredClone(repo.snapshot),
        replaced: true,
        removedIds: [],
        originEpoch: 'old-epoch',
      }),
    });
    await controller.refreshFromRepository();
    expect(controller.state.keyboardOrder).toBeNull();
    expect(controller.state.keyboardReorderError).toContain('replaced');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(move).not.toHaveBeenCalled();
    controller.dispose();
  });
});
