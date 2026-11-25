import { uuid } from '../domain/validation';
import {
  canonicalJson,
  digest,
  preservePendingIntent,
  orderedIntents,
  historyOperationId,
  type PendingIntent,
} from './intents';
import { structuralItems } from '../domain/items';
import {
  historyDestination,
  historyMatches,
} from '../domain/workspace-history';
import { liveQuery } from 'dexie';
import type { ScratchtreeDatabase } from './database';
import type { DexieRepository } from './repository';
import type { BackupFiles } from '../platform/backup-files';
import type { SyncPort, SyncState } from './service-types';
import {
  classifyOutcome,
  witnessMatches,
  readRemoteRow,
  readRemoteOutcome,
  readRemoteLibrary,
  readRemoteEpoch,
  sharedKey,
  type SharedEnvelope,
  type RemoteLibrary,
} from './confirmation';
import {
  rawRecovery,
  RAW_BUFFER_PREFIX,
  ordinaryRecovery,
  resolveIntent,
  cleanupResolvedWitness,
  recoveryChunks,
} from './recovery';
const MAX_STRUCTURE_RECEIPTS = 10;
const structureDigest = (view: RemoteLibrary) =>
  digest(structuralItems({ items: view.items, drafts: [], undoDeleteIds: [] }));

/** Find a short exact chain of subsequent local structural writes. Net-neutral
 * cycles do not need to be part of the proof of the final structure. */
function structuralSuccessors(
  current: PendingIntent,
  pending: readonly PendingIntent[],
  remote: string,
): PendingIntent[] | undefined {
  const after = current.expected.structure?.after;
  if (!after) return;
  const paths = new Map<string, PendingIntent[]>([[after, []]]);
  for (const next of pending) {
    const structure = next.expected.structure;
    if (
      !structure ||
      next.sequence <= current.sequence ||
      next.epoch !== current.epoch
    )
      continue;
    const prior = paths.get(structure.before);
    const known = paths.get(structure.after);
    if (
      prior &&
      prior.length < MAX_STRUCTURE_RECEIPTS &&
      (!known || prior.length + 1 < known.length)
    )
      paths.set(structure.after, [...prior, next]);
  }
  const chain = paths.get(remote);
  if (chain?.length) return chain;
}

export interface SyncEngineOptions {
  db: ScratchtreeDatabase;
  repository: DexieRepository;
  files: BackupFiles;
  serialize: <T>(work: () => Promise<T>) => Promise<T>;
  onInvalidation: () => void | Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  turnTimeoutMs?: number;
}
/** Session owns credentials, transport, the shared lifecycle queue, and database lifetime. */
export class SyncEngine implements SyncPort {
  private state: SyncState = {
    state: 'local-only',
    lastConfirmed: null,
    detail: null,
    recoveries: 0,
  };
  private listeners = new Set<(state: SyncState) => void>();
  private subscriptions: (() => void)[] = [];
  private closed = false;
  private scheduled = false;
  private rerun = false;
  private started = false;
  private baseline: { shared: SharedEnvelope; key: string } | null = null;
  private active: AbortController | null = null;
  private generation = 0;
  private scanAfter = 0;
  private cleanupAfter = '';
  constructor(private options: SyncEngineOptions) {}
  subscribe(listener: (s: SyncState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private patch(value: Partial<SyncState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener(this.state);
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.subscriptions.push(
      this.options.repository.subscribeInvalidation(() => {
        this.invalidate();
        this.schedule();
      }),
    );
    const changes = liveQuery(() =>
      Promise.all([
        this.options.db.pending.toArray(),
        this.options.db.recovery.toArray(),
        this.options.db.drafts.toArray(),
        this.options.db.undo.toArray(),
        this.options.db.device
          .where('key')
          .startsWith(RAW_BUFFER_PREFIX)
          .toArray(),
      ]),
    ).subscribe({
      next: () => this.schedule(),
      error: () =>
        this.patch({
          state: 'needs-sync',
          detail: 'Local sync state needs retry.',
        }),
    });
    this.subscriptions.push(() => changes.unsubscribe());
    if (this.options.db.cloudEnabled) {
      const a = this.options.db.cloud.events.syncComplete.subscribe(() =>
        this.schedule(),
      );
      const b = this.options.db.cloud.syncState.subscribe(() =>
        this.schedule(),
      );
      const c = this.options.db.cloud.webSocketStatus.subscribe(() =>
        this.schedule(),
      );
      this.subscriptions.push(
        () => a.unsubscribe(),
        () => b.unsubscribe(),
        () => c.unsubscribe(),
      );
    }
    this.schedule();
  }
  private invalidate() {
    if (this.closed) return;
    try {
      void Promise.resolve(this.options.onInvalidation()).catch(() =>
        this.patch({ state: 'needs-sync', detail: 'Remote notes need retry.' }),
      );
    } catch {
      this.patch({ state: 'needs-sync', detail: 'Remote notes need retry.' });
    }
  }
  private schedule() {
    if (this.closed) return;
    if (this.scheduled) {
      this.rerun = true;
      return;
    }
    this.scheduled = true;
    this.rerun = false;
    let more = false;
    void this.options
      .serialize(() => this.confirm())
      .then((value) => {
        more = value;
      })
      .catch(() =>
        this.patch({
          state: 'needs-sync',
          detail: 'Server confirmation needs retry.',
        }),
      )
      .finally(() => {
        this.scheduled = false;
        if (!this.closed && (more || this.rerun)) this.schedule();
      });
  }
  close() {
    this.closed = true;
    this.generation++;
    this.active?.abort();
    this.rerun = false;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    this.listeners.clear();
  }
  retry() {
    return this.options
      .serialize(() => this.confirm())
      .then((more) => {
        if (more) this.schedule();
      });
  }
  private async confirm(): Promise<boolean> {
    if (this.closed) return false;
    const controller = new AbortController(),
      generation = ++this.generation;
    this.active = controller;
    const duration = Math.min(
      10000,
      Math.max(1, this.options.turnTimeoutMs ?? 10000),
    );
    const timer = setTimeout(() => controller.abort(), duration);
    try {
      const more = await this.confirmTurn(controller.signal);
      if (controller.signal.aborted && !this.closed) {
        this.patch({
          state: 'needs-sync',
          detail: 'Server confirmation timed out. Your work is retained.',
        });
        return false;
      }
      return (
        !controller.signal.aborted &&
        !this.closed &&
        generation === this.generation &&
        more === true
      );
    } catch {
      if (!this.closed)
        this.patch({
          state: 'needs-sync',
          detail: 'Server confirmation needs retry. Your work is retained.',
        });
      return false;
    } finally {
      clearTimeout(timer);
      if (this.active === controller) this.active = null;
    }
  }
  private async confirmTurn(signal: AbortSignal) {
    const { db, repository } = this.options;
    if (this.closed) return;
    const recoveries = await db.recovery.count();
    const local = await this.confirmableView();
    if (!local) return false;
    if (this.closed || signal.aborted) return false;
    if (!db.cloudEnabled) {
      this.patch({ state: 'local-only', detail: null, recoveries });
      return;
    }
    const currentEpoch = await repository.readCurrentEpoch();
    if (this.baseline?.shared.epoch !== currentEpoch) this.baseline = null;
    const user = db.cloud.currentUser.getValue(),
      databaseUrl = db.cloud.options?.databaseUrl;
    if (
      !user.isLoggedIn ||
      !user.accessToken ||
      !user.accessTokenExpiration ||
      !Number.isFinite(+user.accessTokenExpiration) ||
      +user.accessTokenExpiration <= (this.options.now?.() ?? Date.now()) ||
      !databaseUrl
    ) {
      this.patch({
        state: 'needs-sync',
        detail: 'Sign in to confirm shared notes.',
        recoveries,
      });
      return;
    }
    const announceSync = () => {
      if (this.state.state !== 'syncing')
        this.patch({ state: 'syncing', detail: null, recoveries });
    };
    // Receipt cleanup and device-only changes can schedule a turn without
    // changing the previously confirmed shared view.
    if (
      this.state.state !== 'up-to-date' ||
      local.pendingCount !== 0 ||
      !this.baseline ||
      local.shared.epoch !== currentEpoch ||
      this.baseline.key !== sharedKey(local.shared)
    )
      announceSync();
    const options = {
      databaseUrl,
      token: user.accessToken,
      fetch: this.options.fetch,
      signal,
    };
    try {
      if (
        (await readRemoteEpoch(options, repository.libraryId)) !== currentEpoch
      ) {
        this.baseline = null;
        announceSync();
      }
      let proof = this.baseline?.shared ?? null;
      let serverView: RemoteLibrary | null = null;
      const ordered = orderedIntents(await db.pending.toArray()).filter(
        (p) => p.localApplied,
      );
      if (ordered.length) announceSync();
      let unvisited = ordered.filter((p) => p.sequence > this.scanAfter);
      if (!unvisited.length) {
        this.scanAfter = 0;
        unvisited = ordered;
      }
      const pending = unvisited.slice(0, 8);
      let more = unvisited.length > pending.length;
      for (const p of pending) {
        if (this.closed || signal.aborted) return false;
        if (!p.localApplied) continue;
        const witness = await readRemoteRow(options, 'witnesses', p.id);
        let remote = await readRemoteOutcome(
          { ...options, libraryId: repository.libraryId, epoch: p.epoch },
          p,
        );
        let result = await classifyOutcome(p, witness, remote);
        if (
          p.expected.structure &&
          result === 'superseded' &&
          remote.shared &&
          remote.epoch === p.epoch
        ) {
          const shape = await structureDigest(remote);
          const path = structuralSuccessors(p, ordered, shape);
          if (path) {
            const proofs = await Promise.all(
              path.map((next) => readRemoteRow(options, 'witnesses', next.id)),
            );
            if (path.every((next, i) => witnessMatches(next, proofs[i]))) {
              remote = await readRemoteLibrary({
                ...options,
                libraryId: repository.libraryId,
              });
              if (
                remote.epoch === p.epoch &&
                (await structureDigest(remote)) === shape
              )
                result = 'matching';
              else result = await classifyOutcome(p, witness, remote);
            } else result = 'unknown';
          } else {
            // An unrelated insertion can change the library digest while the
            // exact groups owned by a later reversal still match.
            const action =
              p.command.kind === 'applyHistory'
                ? p.command.request.actionId
                : historyOperationId(p.command);
            const view = { items: remote.items, drafts: [], undoDeleteIds: [] };
            const paired =
              action &&
              ordered.findLast(
                (next) =>
                  next.sequence > p.sequence &&
                  next.epoch === p.epoch &&
                  next.command.kind === 'applyHistory' &&
                  next.command.request.actionId === action &&
                  historyMatches(
                    view,
                    next.command.request.edit,
                    historyDestination(next.command.request),
                  ),
              );
            if (paired) {
              const pairedWitness = await readRemoteRow(
                options,
                'witnesses',
                paired.id,
              );
              if (witnessMatches(paired, pairedWitness)) {
                remote = await readRemoteLibrary({
                  ...options,
                  libraryId: repository.libraryId,
                });
                result = await classifyOutcome(paired, pairedWitness, remote);
              } else result = 'unknown';
            }
          }
        }
        if (remote.shared) {
          serverView = remote;
          this.baseline = null;
          proof = null;
        }
        // A complete view is evidence only until a later observation contradicts it.
        if (remote.observed && serverView?.shared) {
          const observed = remote.observed,
            cached = serverView.shared;
          if (
            canonicalJson(
              cached.notes.find((row) => row.id === observed.id) ?? null,
            ) !== canonicalJson(observed.note) ||
            canonicalJson(
              cached.purges.find((row) => row.id === observed.id) ?? null,
            ) !== canonicalJson(observed.purge)
          )
            serverView = null;
        }
        if (result === 'superseded') {
          this.baseline = null;
          proof = null;
          serverView = null;
        } else if (result === 'matching' && remote.observed && proof) {
          const observed = remote.observed,
            target = local.shared.notes.find((row) => row.id === observed.id),
            purge =
              local.shared.purges.find((row) => row.id === observed.id) ?? null;
          if (
            target &&
            proof.notes.some((row) => row.id === observed.id) &&
            canonicalJson(target) === canonicalJson(observed.note) &&
            canonicalJson(purge) === canonicalJson(observed.purge)
          )
            proof = {
              ...proof,
              notes: proof.notes.map((row) =>
                row.id === observed.id ? target : row,
              ),
            };
          else {
            this.baseline = null;
            proof = null;
            serverView = null;
          }
        }
        if (this.closed || signal.aborted) return false;
        await resolveIntent(db, p, result, signal);
      }
      this.scanAfter = more ? (pending.at(-1)?.sequence ?? this.scanAfter) : 0;
      // The queue is yielded after eight intents and eight exact receipt attempts.
      const receipts = await db.device
        .where('key')
        .startsWith('resolved-witness:')
        .toArray();
      let available = receipts.filter((row) => row.key > this.cleanupAfter);
      if (!available.length) {
        this.cleanupAfter = '';
        available = receipts;
      }
      const cleanup = available.slice(0, 8);
      const moreCleanup = available.length > cleanup.length;
      more = more || moreCleanup;
      for (const row of cleanup) {
        if (this.closed || signal.aborted) return false;
        const value = row.value as { id?: unknown };
        if (typeof value.id !== 'string' || (await db.pending.get(value.id)))
          continue;
        try {
          const remote = await readRemoteRow(options, 'witnesses', value.id);
          if (this.closed || signal.aborted) return false;
          await cleanupResolvedWitness(db, value.id, remote, signal);
        } catch {
          if (signal.aborted)
            throw new Error(
              'Server confirmation was stopped.',
            ); /* A cleanup failure cannot revoke an earlier durable source acknowledgment. */
        }
      }
      this.cleanupAfter = moreCleanup
        ? (cleanup.at(-1)?.key ?? this.cleanupAfter)
        : '';
      let final = await this.confirmableView();
      if (!final) return false;
      let finalKey = sharedKey(final.shared);
      const baseline = this.baseline;
      let evidenced = !!(
        baseline &&
        proof &&
        baseline.shared.epoch === final.shared.epoch &&
        (proof === baseline.shared ? baseline.key : sharedKey(proof)) ===
          finalKey
      );
      if (!evidenced) {
        announceSync();
        const remote =
          serverView ??
          (await readRemoteLibrary({
            ...options,
            libraryId: repository.libraryId,
          }));
        final = await this.confirmableView();
        if (!final) return false;
        finalKey = sharedKey(final.shared);
        evidenced = !!(
          remote.shared &&
          remote.epoch === final.shared.epoch &&
          sharedKey(remote.shared) === finalKey &&
          canonicalJson(remote.items) === canonicalJson(final.items) &&
          canonicalJson(remote.purgedIds) === canonicalJson(final.purgedIds)
        );
      }
      this.baseline = evidenced
        ? { shared: final.shared, key: finalKey }
        : null;
      const remaining = final.pendingCount;
      if (this.closed || signal.aborted) return false;
      this.patch({
        state: remaining || !this.baseline ? 'needs-sync' : 'up-to-date',
        detail:
          remaining || !this.baseline
            ? 'Some changes are awaiting server confirmation.'
            : final.recoveries
              ? 'Alternative input is retained in recovery.'
              : null,
        recoveries: final.recoveries,
        ...(!remaining && this.baseline && this.state.state === 'syncing'
          ? { lastConfirmed: this.options.now?.() ?? Date.now() }
          : {}),
      });
      return more;
    } catch {
      if (this.closed) return false;
      this.patch({
        state: 'needs-sync',
        detail:
          'Server confirmation or the merged library needs retry. Your work is retained.',
        recoveries: await db.recovery.count(),
      });
      return false;
    }
  }
  private async confirmableView() {
    const assessment = await this.options.repository.assessView();
    if (assessment.kind === 'ready') {
      if (this.state.overflow !== undefined)
        this.patch({ overflow: undefined });
      return assessment;
    }
    const shared = assessment.kind === 'shared-capacity';
    this.patch({
      state: 'needs-sync',
      recoveries: await this.options.db.recovery.count(),
      detail: shared
        ? 'The merged library exceeds its limits. Export the full raw library before removing notes.'
        : assessment.kind === 'invalid-shared'
          ? 'The shared notes contain invalid data. Export the full raw library for repair.'
          : assessment.kind === 'device-capacity'
            ? 'These notes and this Mac’s drafts and recovery exceed local capacity. Export the full raw library. A smaller shared library can reopen with your drafts intact.'
            : 'Saved input is waiting for the workspace to reopen.',
      overflow:
        assessment.kind === 'adoption'
          ? undefined
          : { items: assessment.shared.notes.length, correctable: shared },
    });
    return null;
  }
  async inspectOverflow() {
    return this.options.serialize(async () => {
      const assessment = await this.options.repository.assessView();
      const raw = assessment.shared;
      const overflow = assessment.kind === 'shared-capacity';
      return {
        epoch: raw.epoch,
        overflow,
        rows: raw.notes.flatMap((value) => {
          if (!value || typeof value !== 'object') return [];
          const row = value as { id?: unknown; markdown?: unknown };
          return uuid(row.id) && typeof row.markdown === 'string'
            ? [{ id: row.id, markdown: row.markdown }]
            : [];
        }),
      };
    });
  }
  async purgeOverflow(request: { epoch: string; ids: string[] }) {
    const captured = structuredClone(request);
    await this.options.serialize(async () => {
      const { db, repository } = this.options;
      if (this.closed) throw new Error('Sync is closed.');
      const assessment = await repository.assessView();
      if (assessment.kind !== 'shared-capacity')
        throw new Error(
          'The shared notes are within their limits. Use normal deletion.',
        );
      if (
        !captured.ids.length ||
        captured.ids.some((id) => !uuid(id)) ||
        new Set(captured.ids).size !== captured.ids.length
      )
        throw new Error('Select exact recovery notes.');
      const available = new Set(assessment.shared.notes.map((row) => row.id));
      if (
        assessment.shared.epoch !== captured.epoch ||
        captured.ids.some((id) => !available.has(id))
      )
        throw new Error('The recovery selection changed.');
      const command = {
        kind: 'correctivePurge' as const,
        epoch: captured.epoch,
        ids: captured.ids,
      };
      const expected = { items: [], orders: [], purgedIds: captured.ids };
      const fingerprint = await digest({ epoch: captured.epoch, command });
      const existing = (
        await db.pending.where('fingerprint').equals(fingerprint).toArray()
      )[0];
      const intent: PendingIntent = existing ?? {
        id: crypto.randomUUID(),
        epoch: captured.epoch,
        fingerprint,
        digest: await digest({ command, expected }),
        recordedAt: Date.now(),
        command,
        expected,
        localApplied: false,
        sequence: 0,
      };
      // Preservation is committed separately before any replicated mutation.
      await preservePendingIntent(db, intent);
      await db.transaction('rw', db.tables, async () => {
        if (
          (await db.libraries.get(repository.libraryId))?.epoch !==
          captured.epoch
        )
          throw new Error('The library was replaced.');
        if ((await repository.assessView()).kind !== 'shared-capacity')
          throw new Error(
            'The shared notes are within their limits. Use normal deletion.',
          );
        for (const id of captured.ids) {
          if (!(await db.notes.get([captured.epoch, id])))
            throw new Error('The recovery selection changed.');
        }
        for (const id of captured.ids) {
          await db.notes.delete([captured.epoch, id]);
          await db.purges.put({
            id,
            epoch: captured.epoch,
            purgedAt: intent.recordedAt,
          });
        }
        await db.witnesses.put({
          id: intent.id,
          epoch: intent.epoch,
          digest: intent.digest,
          recordedAt: intent.recordedAt,
        });
        await db.pending.update(intent.id, { localApplied: true });
        await repository.settleLocalWrites();
      });
    });
    this.invalidate();
    this.schedule();
  }
  exportRecovery() {
    return this.writeRecovery(false);
  }
  exportOverflow() {
    return this.writeRecovery(true);
  }
  private async writeRecovery(full: boolean) {
    await this.options.serialize(async () => {
      if (this.closed) return;
      const raw = full
        ? await rawRecovery(this.options.db, this.options.repository.libraryId)
        : await ordinaryRecovery(this.options.db);
      if (this.options.files.chooseRecoveryWrite) {
        await this.options.files.chooseRecoveryWrite(recoveryChunks(raw));
        return;
      }
      let text = '';
      let bytes = 0;
      for await (const chunk of recoveryChunks(raw)) {
        bytes += new TextEncoder().encode(chunk).length;
        if (bytes > 10 * 1024 * 1024)
          throw new Error(
            'This raw recovery needs the dedicated recovery file writer. Your rows are retained.',
          );
        text += chunk;
      }
      await this.options.files.chooseWrite(text);
    });
  }
}
