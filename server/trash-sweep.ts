import { expiredTrashIds } from '../src/lib/domain/trash-retention';
import { encodeCloudBackup } from '../src/lib/sync/backup';
import { projectLibrary } from '../src/lib/sync/canonical';
import {
  readRemoteEpoch,
  readRemoteEpochRows,
  readRemoteLibrary,
  type RemoteReadOptions,
  type SharedEnvelope,
} from '../src/lib/sync/confirmation';
import { canonicalJson, libraryIdForUser } from '../src/lib/sync/intents';
import type {
  ProjectionNotice,
  PurgeRow,
  SharedItem,
} from '../src/lib/sync/types';

// Netlify stops scheduled functions at 30 seconds. Leave time for telemetry
// and avoid beginning another note when the remaining work budget is short.
const workTimeoutMs = 22_000;
const latestWriteStartMs = 18_000;
const telemetryTimeoutMs = 2_000;
const maxNotesPerRun = 25;

type Env = Readonly<Record<string, string | undefined>>;
type Failure =
  | 'configuration'
  | 'token'
  | 'library'
  | 'epoch'
  | 'purge fact'
  | 'delete'
  | 'telemetry'
  | 'timeout';
interface SweepCounts {
  mode: 'dry-run' | 'purge';
  eligible: number;
  pendingDeletes: number;
  purged: number;
  resumed: number;
  remaining: number;
}
interface Dependencies {
  fetch?: typeof fetch;
  now?: () => number;
  log?: (entry: object) => void;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function dexieOrigin(value: string | undefined) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      /^[a-z0-9-]+\.dexie\.cloud$/.test(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {
    // Malformed configuration is handled by the caller.
  }
}

function cronitorUrl(env: Env) {
  const apiKey = env.SCRATCHTREE_TRASH_CRONITOR_API_KEY?.trim();
  const monitor = env.SCRATCHTREE_TRASH_CRONITOR_MONITOR_KEY?.trim();
  if (
    !apiKey ||
    !monitor ||
    apiKey === '.' ||
    apiKey === '..' ||
    monitor === '.' ||
    monitor === '..'
  )
    return;
  return `https://cronitor.link/p/${encodeURIComponent(apiKey)}/${encodeURIComponent(monitor)}`;
}

async function report(send: typeof fetch, url: string, state: 'tick' | 'fail') {
  const response = await send(`${url}?state=${state}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(telemetryTimeoutMs),
  });
  if (!response.ok) throw new Error('Cronitor rejected the event.');
}

function protectedComponents(
  shared: SharedEnvelope,
  notices: ProjectionNotice[],
) {
  // Follow the actual parent edges. Other projection repairs can detach
  // descendants from an orphaned or cyclic component in the canonical view.
  const children = new Map<string, string[]>();
  for (const row of shared.notes) {
    const { parentId } = row.placement;
    if (parentId === null) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(row.id);
    children.set(parentId, siblings);
  }
  const protectedIds = new Set<string>();
  const stack = notices
    .filter((notice) => notice.kind === 'orphan' || notice.kind === 'cycle')
    .map((notice) => notice.itemId);
  while (stack.length) {
    const id = stack.pop()!;
    if (protectedIds.has(id)) continue;
    protectedIds.add(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return protectedIds;
}

function matchesCapturedLeaf(
  id: string,
  captured: ReadonlyMap<string, SharedItem>,
  rows: unknown[],
) {
  const current = new Map<string, Record<string, unknown>>();
  let hasChildren = false;
  for (const row of rows) {
    if (
      !record(row) ||
      typeof row.id !== 'string' ||
      !record(row.placement) ||
      current.has(row.id)
    )
      throw new Error('Invalid note placement.');
    current.set(row.id, row);
    if (row.placement.parentId === id) hasChildren = true;
  }
  if (hasChildren) return false;
  // A leaf's row can be unchanged when another device restores or
  // re-deletes the tree from which it inherits Trash.
  let cursor: string | null = id;
  while (cursor !== null) {
    const before = captured.get(cursor);
    const row = current.get(cursor);
    if (
      !before ||
      !row ||
      row.kind !== before.kind ||
      row.createdAt !== before.createdAt ||
      canonicalJson(row.placement) !== canonicalJson(before.placement)
    )
      return false;
    cursor = before.placement.parentId;
  }
  return true;
}

async function write(
  remote: RemoteReadOptions & { fetch: typeof fetch; signal: AbortSignal },
  action: { purge: PurgeRow } | { delete: [string, string] },
) {
  const headers = { Authorization: `Bearer ${remote.token}` };
  const key =
    'delete' in action
      ? encodeURIComponent(JSON.stringify(action.delete))
      : null;
  remote.signal.throwIfAborted();
  const response =
    'purge' in action
      ? await remote.fetch(`${remote.databaseUrl}/my/purges`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(action.purge),
          signal: remote.signal,
        })
      : await remote.fetch(`${remote.databaseUrl}/my/notes/${key}`, {
          method: 'DELETE',
          headers,
          signal: remote.signal,
        });
  if (
    ![200, 201, 204].includes(response.status) &&
    !(key && response.status === 404)
  ) {
    throw new Error('Dexie did not acknowledge the write.');
  }
}

export async function runTrashSweep(
  env: Env,
  {
    fetch: send = fetch,
    now = Date.now,
    log = console.info,
  }: Dependencies = {},
): Promise<SweepCounts | { mode: 'disabled' }> {
  const mode = env.SCRATCHTREE_TRASH_SWEEP_MODE ?? 'disabled';
  if (mode === 'disabled') {
    log({ event: 'trash sweep disabled' });
    return { mode };
  }

  const started = performance.now();
  const signal = AbortSignal.timeout(workTimeoutMs);
  const dexieFetch: typeof fetch = (input, init) =>
    send(input, { ...init, redirect: 'error' });
  let stage: Failure = 'configuration';
  let monitor: string | undefined;
  let counts: SweepCounts | undefined;
  try {
    monitor = cronitorUrl(env);
    const databaseUrl = dexieOrigin(env.SCRATCHTREE_TRASH_DEXIE_URL);
    const clientId = env.SCRATCHTREE_TRASH_DEXIE_CLIENT_ID?.trim();
    const clientSecret = env.SCRATCHTREE_TRASH_DEXIE_CLIENT_SECRET?.trim();
    const userId = env.SCRATCHTREE_TRASH_DEXIE_USER_ID?.trim();
    if (
      (mode !== 'dry-run' && mode !== 'purge') ||
      !databaseUrl ||
      !clientId ||
      !clientSecret ||
      !userId ||
      !monitor
    )
      throw new Error('Invalid configuration.');

    stage = 'token';
    const tokenResponse = await dexieFetch(`${databaseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        scopes: ['ACCESS_DB'],
        client_id: clientId,
        client_secret: clientSecret,
        claims: { sub: userId },
      }),
      signal,
    });
    if (tokenResponse.status !== 200) throw new Error('Token request failed.');
    const reply: unknown = await tokenResponse.json();
    if (
      !record(reply) ||
      reply.type !== 'tokens' ||
      !record(reply.claims) ||
      reply.claims.sub !== userId ||
      typeof reply.accessToken !== 'string' ||
      !reply.accessToken
    )
      throw new Error('Invalid scoped token.');

    stage = 'library';
    const remote = {
      databaseUrl,
      token: reply.accessToken,
      fetch: dexieFetch,
      signal,
    };
    const libraryId = await libraryIdForUser(userId);
    const { shared, epoch, items, notices, purgedIds } =
      await readRemoteLibrary({
        ...remote,
        libraryId,
      });
    const tombstones = new Set(purgedIds);
    const pending = shared.notes
      .filter((row) => tombstones.has(row.id))
      .map((row) => row.id);
    const sweepTime = now();
    const eligible = expiredTrashIds(
      items,
      sweepTime,
      protectedComponents(shared, notices),
    );
    counts = {
      mode,
      eligible: eligible.length,
      pendingDeletes: pending.length,
      purged: 0,
      resumed: 0,
      remaining: eligible.length + pending.length,
    };

    if (mode === 'purge') {
      const unfinished = pending.slice(0, maxNotesPerRun);
      const additions = eligible
        .slice(0, maxNotesPerRun - unfinished.length)
        .map((id): PurgeRow => ({ id, epoch, purgedAt: sweepTime }));
      if (additions.length) {
        // Model the fact-first intermediate state with raw notes still
        // present. Each prefix removes visible leaves and adds smaller facts.
        const next = projectLibrary(
          shared.notes,
          shared.orders,
          [...shared.purges, ...additions],
          epoch,
        );
        encodeCloudBackup({
          library: { items: next.items, purgedIds: next.purgedIds },
          device: { drafts: [], undoDeleteIds: [], recovery: [] },
        });
      }

      const checkEpoch = async () => {
        stage = 'epoch';
        if ((await readRemoteEpoch(remote, libraryId)) !== epoch)
          throw new Error('Active epoch changed.');
      };
      const captured = new Map(shared.notes.map((note) => [note.id, note]));
      for (const [id, fact] of [
        ...unfinished.map((id) => [id, null] as const),
        ...additions.map((fact) => [fact.id, fact] as const),
      ]) {
        signal.throwIfAborted();
        if (performance.now() - started >= latestWriteStartMs) {
          if (counts.purged + counts.resumed === 0) {
            stage = 'timeout';
            throw new Error('No time to begin the sweep.');
          }
          break;
        }
        if (fact) {
          stage = 'library';
          const current = await readRemoteEpochRows(remote, 'notes', epoch);
          if (!matchesCapturedLeaf(id, captured, current)) continue;
          await checkEpoch();
          stage = 'purge fact';
          await write(remote, { purge: fact });
        }
        await checkEpoch();
        stage = 'delete';
        await write(remote, { delete: [epoch, id] });
        if (fact) counts.purged++;
        else counts.resumed++;
        counts.remaining--;
      }
    }

    signal.throwIfAborted();
    stage = 'telemetry';
    await report(send, monitor, 'tick');
    log({ event: 'trash sweep complete', ...counts });
    return counts;
  } catch {
    const failure = signal.aborted && stage !== 'telemetry' ? 'timeout' : stage;
    log({ event: 'trash sweep failed', failure, ...counts });
    if (monitor) {
      try {
        await report(send, monitor, 'fail');
      } catch {
        log({ event: 'trash sweep failure telemetry unavailable' });
      }
    }
    throw new Error(`Trash sweep failed: ${failure}.`);
  }
}
