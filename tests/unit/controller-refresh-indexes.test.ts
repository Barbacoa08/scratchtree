import { expect, it } from 'vitest';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import { MemoryRepository } from '../fixtures/memory';
import { item } from '../fixtures/items';

it('refreshes many cached editors without repeatedly scanning every item and draft', async () => {
  const count = 128;
  const ids = Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  );
  const repo = new MemoryRepository();
  repo.snapshot.items = ids.map((id, position) =>
    item({ id, position, markdown: `old ${position}` }),
  );
  repo.snapshot.drafts = ids.map((key) => ({
    key,
    markdown: 'old draft',
    revision: 2,
    updatedAt: 0,
  }));
  const controller = new WorkspaceController(repo);
  try {
    await controller.start();
    const workspace = structuredClone(repo.snapshot);
    let itemReads = 0,
      draftReads = 0;
    workspace.items.forEach((row, i) => {
      row.markdown = `saved ${i}`;
      Object.defineProperty(row, 'id', {
        enumerable: true,
        get: () => {
          itemReads++;
          return ids[i];
        },
      });
    });
    workspace.drafts = workspace.drafts.filter((_, i) => i % 2 === 0);
    workspace.drafts.forEach((row) => {
      const key = row.key;
      row.markdown = `draft ${key}`;
      Object.defineProperty(row, 'key', {
        enumerable: true,
        get: () => {
          draftReads++;
          return key;
        },
      });
    });
    Object.assign(repo, {
      refreshFromRemote: async () => ({
        workspace,
        replaced: false,
        removedIds: [],
        originEpoch: 'synthetic',
      }),
    });
    expect(await controller.refreshFromRepository()).toBe(true);
    ids.forEach((id, i) => {
      expect(controller.state.buffers[id]).toEqual({
        source: i % 2 === 0 ? `draft ${id}` : `saved ${i}`,
        revision: 2,
      });
    });
    expect(controller.state.buffers.compose.source).toBe('');
    expect(itemReads).toBeLessThanOrEqual(count * 4);
    expect(draftReads).toBeLessThanOrEqual(count * 4);
  } finally {
    controller.dispose();
  }
});
