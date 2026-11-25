import { describe, expect, it, vi } from 'vitest';
import scheduledSweep from '../../deploy/maintenance/functions/trash-sweep';
import { runTrashSweep } from '../../server/trash-sweep';
import type { OrderRow, PurgeRow, SharedItem } from '../../src/lib/sync/types';

const day = 86_400_000;
const now = 500 * day;
const epoch = 'active-epoch';
const user = 'managed@example.test';
const libraryId =
  '00b6255381587f8ff2e5f6bff850f1e44209aad3f3167c03bd5fc8c732b31f6a';
const environment = {
  SCRATCHTREE_TRASH_SWEEP_MODE: 'purge',
  SCRATCHTREE_TRASH_DEXIE_URL: 'https://disposable.dexie.cloud',
  SCRATCHTREE_TRASH_DEXIE_CLIENT_ID: 'synthetic-client',
  SCRATCHTREE_TRASH_DEXIE_CLIENT_SECRET: 'synthetic-secret',
  SCRATCHTREE_TRASH_DEXIE_USER_ID: user,
  SCRATCHTREE_TRASH_CRONITOR_API_KEY: 'synthetic-key',
  SCRATCHTREE_TRASH_CRONITOR_MONITOR_KEY: 'synthetic-monitor',
};

function id(n: number) {
  return '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
}

function note(
  n: number,
  deletedAt: number | null,
  parentId: string | null = null,
): SharedItem {
  return {
    id: id(n),
    epoch,
    kind: 'note',
    createdAt: day,
    updatedAt: day,
    markdown: 'Synthetic Markdown',
    done: false,
    color: null,
    placement: {
      parentId,
      deletedAt,
      restoreParentId: null,
      restoreIndex: null,
    },
  };
}

function hosted(notes: SharedItem[] = []) {
  const server = {
    notes: new Map(notes.map((row) => [row.id, row])),
    purges: new Map<string, PurgeRow>(),
    orders: [] as OrderRow[],
    events: [] as Array<[string, string?]>,
    logs: [] as unknown[],
    subject: user,
    pointerReads: 0,
    replaceOnPointerRead: 0,
    failDelete: false,
    failTelemetry: false,
    partialNotes: false,
    afterDelete: () => {},
  };
  const owned = <T extends object>(row: T) => ({
    ...row,
    owner: user,
    realmId: user,
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(request.redirect).toBe('error');

    if (url.origin === 'https://cronitor.link') {
      expect(url.pathname).toBe('/p/synthetic-key/synthetic-monitor');
      expect(request.headers.has('authorization')).toBe(false);
      expect(request.method).toBe('GET');
      server.events.push(['telemetry', url.searchParams.get('state')!]);
      return new Response(null, { status: server.failTelemetry ? 503 : 204 });
    }

    expect(url.origin).toBe('https://disposable.dexie.cloud');
    if (url.pathname === '/token') {
      expect(request.method).toBe('POST');
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(await request.json()).toEqual({
        grant_type: 'client_credentials',
        scopes: ['ACCESS_DB'],
        client_id: 'synthetic-client',
        client_secret: 'synthetic-secret',
        claims: { sub: user },
      });
      server.events.push(['token']);
      return Response.json({
        type: 'tokens',
        claims: { sub: server.subject },
        accessToken: 'synthetic-access-token',
        accessTokenExpiration: now + 3_600_000,
        userType: 'prod',
      });
    }

    expect(request.headers.get('authorization')).toBe(
      'Bearer synthetic-access-token',
    );
    if (url.pathname === '/my/libraries/' + libraryId) {
      expect(request.method).toBe('GET');
      server.pointerReads++;
      const active =
        server.replaceOnPointerRead &&
        server.pointerReads >= server.replaceOnPointerRead
          ? 'replacement-epoch'
          : epoch;
      return Response.json(owned({ id: libraryId, epoch: active }));
    }
    if (request.method === 'GET') {
      expect(url.searchParams.get('epoch')).toBe(epoch);
      switch (url.pathname) {
        case '/my/notes':
          return Response.json([...server.notes.values()].map(owned), {
            headers: server.partialNotes ? { 'content-range': '0-1/10' } : {},
          });
        case '/my/orders':
          return Response.json(server.orders.map(owned));
        case '/my/purges':
          return Response.json([...server.purges.values()].map(owned));
      }
    }
    if (request.method === 'POST' && url.pathname === '/my/purges') {
      const row = (await request.json()) as PurgeRow;
      expect(row).toEqual({ id: row.id, epoch, purgedAt: now });
      expect(server.notes.has(row.id)).toBe(true);
      server.purges.set(row.id, row);
      server.events.push(['purge fact', row.id]);
      return new Response(null, { status: 200 });
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/my/notes/')) {
      const key = JSON.parse(decodeURIComponent(url.pathname.split('/')[3]));
      expect(key).toEqual([epoch, key[1]]);
      expect(server.purges.has(key[1])).toBe(true);
      server.events.push(['delete', key[1]]);
      if (server.failDelete)
        return new Response('Synthetic Markdown', { status: 503 });
      const removed = server.notes.delete(key[1]);
      server.afterDelete();
      return new Response(null, {
        status: removed ? 204 : 404,
      });
    }
    throw new Error('Unexpected synthetic request');
  };
  return {
    server,
    run: (env: Record<string, string> = environment) =>
      runTrashSweep(env, {
        fetch,
        now: () => now,
        log: (entry) => server.logs.push(entry),
      }),
  };
}

describe('hosted Trash sweep', () => {
  it('only dispatches the sweep from the published production function', async () => {
    vi.stubEnv('SCRATCHTREE_TRASH_SWEEP_MODE', 'disabled');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const request = new Request('https://maintenance.example.test');
    try {
      await scheduledSweep(request, {
        deploy: { context: 'deploy-preview', published: true },
      });
      await scheduledSweep(request, {
        deploy: { context: 'production', published: false },
      });
      expect(log).not.toHaveBeenCalled();
      await scheduledSweep(request, {
        deploy: { context: 'production', published: true },
      });
      expect(log).toHaveBeenCalledExactlyOnceWith({
        event: 'trash sweep disabled',
      });
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('defaults to disabled without contacting either service', async () => {
    const { server, run } = hosted([note(1, day)]);
    await expect(run({})).resolves.toEqual({ mode: 'disabled' });
    expect(server.events).toEqual([]);
  });

  it('reports dry-run candidates after a user-scoped read without writes', async () => {
    const { server, run } = hosted([
      note(1, now - 180 * day - 1),
      note(2, now - 180 * day),
    ]);
    await expect(
      run({ ...environment, SCRATCHTREE_TRASH_SWEEP_MODE: 'dry-run' }),
    ).resolves.toMatchObject({ mode: 'dry-run', eligible: 1, purged: 0 });
    expect(server.events).toEqual([['token'], ['telemetry', 'tick']]);
    expect(server.notes.size).toBe(2);
    expect(server.purges.size).toBe(0);
  });

  it('writes durable facts and deletes exact descendants before their parents', async () => {
    const { server, run } = hosted([
      note(1, day),
      note(2, null, id(1)),
      note(3, day),
      note(4, now - day, id(3)),
      note(5, null),
    ]);
    server.orders.push({
      id: 'trash-order',
      epoch,
      parentId: null,
      scope: 'trash',
      ids: [id(3), id(1)],
    });
    await expect(run()).resolves.toMatchObject({ purged: 2, remaining: 0 });
    expect(server.events).toEqual([
      ['token'],
      ['purge fact', id(2)],
      ['delete', id(2)],
      ['purge fact', id(1)],
      ['delete', id(1)],
      ['telemetry', 'tick'],
    ]);
    expect([...server.notes.keys()]).toEqual([id(3), id(4), id(5)]);
    expect(server.orders[0].ids).toEqual([id(3), id(1)]);
  });

  it('leaves an old tree in Trash when a new child is saved during the sweep', async () => {
    const tree = { ...note(1, day), kind: 'tree' as const };
    const { server, run } = hosted([tree, note(2, null, id(1))]);
    server.afterDelete = () => {
      server.notes.set(id(3), {
        ...note(3, null, id(1)),
        createdAt: now,
        updatedAt: now,
      });
    };
    await expect(run()).resolves.toMatchObject({ purged: 1 });
    expect([...server.notes.keys()]).toEqual([id(1), id(3)]);
    expect([...server.purges.keys()]).toEqual([id(2)]);
  });

  it('skips inherited Trash when its ancestor was restored during the sweep', async () => {
    const tree = { ...note(2, day), kind: 'tree' as const };
    const { server, run } = hosted([note(1, day), tree, note(3, null, id(2))]);
    server.afterDelete = () => {
      server.notes.set(id(2), {
        ...tree,
        placement: { ...tree.placement, deletedAt: null },
      });
    };
    await expect(run()).resolves.toMatchObject({ purged: 1 });
    expect([...server.notes.keys()]).toEqual([id(2), id(3)]);
    expect([...server.purges.keys()]).toEqual([id(1)]);
  });

  it('finishes an interrupted exact deletion from its existing purge fact', async () => {
    const { server, run } = hosted([note(1, day), note(2, null, id(1))]);
    server.failDelete = true;
    await expect(run()).rejects.toThrow('delete');
    expect([...server.notes.keys()]).toEqual([id(1), id(2)]);
    expect([...server.purges.keys()]).toEqual([id(2)]);
    expect(server.events.at(-1)).toEqual(['telemetry', 'fail']);

    server.failDelete = false;
    server.events.length = 0;
    await expect(run()).resolves.toMatchObject({ purged: 1, resumed: 1 });
    expect(server.events).toEqual([
      ['token'],
      ['delete', id(2)],
      ['purge fact', id(1)],
      ['delete', id(1)],
      ['telemetry', 'tick'],
    ]);
    expect(server.notes.size).toBe(0);
    expect(JSON.stringify(server.logs)).not.toMatch(
      /Synthetic Markdown|synthetic-secret|managed@example/,
    );
  });

  it('begins a new sweep only with a token issued to the configured subject', async () => {
    const { server, run } = hosted([note(1, day)]);
    server.subject = 'unexpected@example.test';
    await expect(run()).rejects.toThrow('token');
    expect(server.pointerReads).toBe(0);
    expect(server.purges.size).toBe(0);
    expect(server.events).toEqual([['token'], ['telemetry', 'fail']]);
  });

  it('stops on an epoch change immediately before a purge fact', async () => {
    const { server, run } = hosted([note(1, day)]);
    server.replaceOnPointerRead = 3;
    await expect(run()).rejects.toThrow('epoch');
    expect(server.purges.size).toBe(0);
    expect(server.notes.size).toBe(1);
    expect(server.events).toEqual([['token'], ['telemetry', 'fail']]);
  });

  it('leaves an acknowledged fact in its original epoch when the pointer switches', async () => {
    const { server, run } = hosted([note(1, day)]);
    server.replaceOnPointerRead = 4;
    await expect(run()).rejects.toThrow('epoch');
    expect(server.purges.get(id(1))?.epoch).toBe(epoch);
    expect(server.notes.size).toBe(1);
    expect(server.events).toEqual([
      ['token'],
      ['purge fact', id(1)],
      ['telemetry', 'fail'],
    ]);
  });

  it('does not age orphaned or cyclic components from their repaired projections', async () => {
    const { server, run } = hosted([
      note(1, null, id(20)),
      note(2, day, id(1)),
      note(3, day, id(4)),
      note(4, null, id(3)),
      note(5, day),
    ]);
    await expect(run()).resolves.toMatchObject({ eligible: 1, purged: 1 });
    expect([...server.notes.keys()]).toEqual([id(1), id(2), id(3), id(4)]);
    expect([...server.purges.keys()]).toEqual([id(5)]);
  });

  it('refuses a partial active-library response before changing data', async () => {
    const { server, run } = hosted([note(1, day)]);
    server.partialNotes = true;
    await expect(run()).rejects.toThrow('library');
    expect(server.purges.size).toBe(0);
    expect(server.notes.size).toBe(1);
  });

  it('limits a run and continues from the next active projection', async () => {
    const { server, run } = hosted(
      Array.from({ length: 27 }, (_, n) => note(n + 1, day)),
    );
    await expect(run()).resolves.toMatchObject({ purged: 25, remaining: 2 });
    expect(server.notes.size).toBe(2);
    await expect(run()).resolves.toMatchObject({ purged: 2, remaining: 0 });
    expect(server.notes.size).toBe(0);
  });

  it('reports a work deadline that leaves an eligible sweep with zero progress', async () => {
    const { server, run } = hosted([note(1, day)]);
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(18_001);
    try {
      await expect(run()).rejects.toThrow('timeout');
      expect(server.purges.size).toBe(0);
      expect(server.events).toEqual([['token'], ['telemetry', 'fail']]);
    } finally {
      clock.mockRestore();
    }
  });

  it('sends a completion heartbeat with an empty eligible set', async () => {
    const { server, run } = hosted([note(1, null)]);
    await expect(run()).resolves.toMatchObject({ eligible: 0, purged: 0 });
    expect(server.events).toEqual([['token'], ['telemetry', 'tick']]);
  });

  it('keeps a deletion failure visible when failure telemetry also fails', async () => {
    const { server, run } = hosted([note(1, day)]);
    server.failDelete = server.failTelemetry = true;
    await expect(run()).rejects.toThrow('delete');
    expect(server.events.at(-1)).toEqual(['telemetry', 'fail']);
  });
});
