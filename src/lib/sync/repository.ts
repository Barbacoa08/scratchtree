import {
  readArchive,
  readActivation,
  installDevice,
  snapshotOf,
  type Transfer,
} from './detached';
import {
  retainRawBuffers,
  readRawBuffers,
  rawBufferKey,
  RAW_BUFFER_PREFIX,
  type RawBuffer,
} from './recovery';
import {
  toSharedItem as share,
  orderRows as orders,
  orderGroupId,
} from './representation';
import { liveQuery } from 'dexie';
import type {
  ColorToken,
  Draft,
  Item,
  Location,
  WorkspaceSnapshot,
} from '../domain/notes';
import { emptyWorkspace, MAX_ENVELOPE } from '../domain/notes';
import * as rules from '../domain/items';
import {
  applyCapturedHistory,
  ChangedHistory,
  type HistoryRequest,
} from '../domain/workspace-history';
import { composeOwner, effectiveScope } from '../domain/hierarchy';
import type { BackupFiles } from '../platform/backup-files';
import type {
  CaptureItem,
  CreateChildTree,
  DraftAck,
  DeleteAttempt,
  MoveItems,
  PurgeRequest,
  ReorderItem,
  Repository,
  RemoteBuffer,
  RemoteRefresh,
  RestorePreview,
  TransitionLocation,
  UndoDeleteRequest,
} from '../platform/workspace';
import { ScratchtreeDatabase } from './database';
import type { DeviceRow, UndoRow } from './database';
import { projectLibrary } from './canonical';
import {
  encodeCloudBackup,
  LibraryCapacityError,
  serializeCloudBackup,
  validateCloudBackup,
  validateIndexedBackup,
  type BackupV8,
  type RecoveryRecord,
} from './backup';
import {
  digest,
  canonicalJson,
  preservePendingIntent,
  historyOperationId,
  orderedIntents,
  readJournalMetadata,
  sourceOfIntent,
  sourceHeadKey,
  type IntentCommand,
  type PendingIntent,
  type ExpectedOutcome,
  type ItemFieldDeltas,
} from './intents';
import type { SharedItem, OrderRow, Placement } from './types';
const equal = (a: unknown, b: unknown) =>
  a === b || canonicalJson(a) === canonicalJson(b);
// Both items have passed the same strict field validation.
const sameItem = (a: Item, b: Item) =>
  (Object.keys(a) as (keyof Item)[]).every((key) => equal(a[key], b[key]));
const bytes = (x: unknown) =>
  new TextEncoder().encode(JSON.stringify(x)).length;
const providerFields = <T>(row: T): T => {
  const copy = { ...row } as T & { owner?: unknown; realmId?: unknown };
  delete copy.owner;
  delete copy.realmId;
  return copy;
};
const placement = (item: Item): Placement => ({
  parentId: item.parentId,
  deletedAt: item.deletedAt,
  restoreParentId: item.restoreParentId,
  restoreIndex: item.restoreIndex,
});
interface State {
  epoch: string;
  snapshot: WorkspaceSnapshot;
  purgedIds: string[];
  recovery: RecoveryRecord[];
  undo?: UndoRow;
}
type CheckedState = State & { backupBytes: number };

interface ItemChange {
  id: string;
  before?: Item;
  after?: Item;
}

interface IndexedChanges {
  items: ItemChange[];
  orderGroups: Set<string>;
}

function itemChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot) {
  const old = new Map(before.items.map((item) => [item.id, item]));
  const next = new Map(after.items.map((item) => [item.id, item]));
  const changes: ItemChange[] = [];
  // Keep journal ordering based on prior items followed by new IDs.
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const prior = old.get(id),
      value = next.get(id);
    if (!prior || !value || !sameItem(prior, value))
      changes.push({ id, before: prior, after: value });
  }
  return changes;
}

function indexedChanges(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): IndexedChanges {
  const items = itemChanges(before, after);
  const orderGroups = new Set<string>();
  for (const change of items) {
    const old = change.before && orderGroupId(change.before);
    const next = change.after && orderGroupId(change.after);
    if (old === next && change.before?.position === change.after?.position)
      continue;
    if (old !== undefined) orderGroups.add(old);
    if (next !== undefined) orderGroups.add(next);
  }
  return { items, orderGroups };
}

function canIndex(command: IntentCommand, snapshot: WorkspaceSnapshot) {
  if (command.kind === 'captureItem')
    return !snapshot.items.some((item) => item.id === command.request.id);
  if (command.kind !== 'deleteItem' || command.leave) return false;
  const target = snapshot.items.find((item) => item.id === command.id);
  return (
    !!target &&
    target.deletedAt === null &&
    (target.parentId === null ||
      effectiveScope(snapshot.items, target.id) === 'live')
  );
}

function copyMutation(state: State, indexed: boolean): State {
  if (!indexed) return structuredClone(state);
  // These commands change scalar item fields and replace the draft or Undo
  // list. Copy the records without cloning the unchanged Markdown strings.
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      items: state.snapshot.items.map(
        (item) =>
          ({ ...item }) satisfies Record<
            keyof Item,
            string | number | boolean | null
          >,
      ),
    },
    recovery: structuredClone(state.recovery),
  };
}

function undoFacts(snapshot: WorkspaceSnapshot) {
  const ids = new Set(snapshot.undoDeleteIds);
  return ids.size === 0
    ? []
    : rules.structuralItems({
        ...snapshot,
        items: snapshot.items.filter((item) => ids.has(item.id)),
      });
}

const unavailable = () =>
  Object.assign(
    new Error(
      'This note is unavailable. Your latest input is retained for recovery.',
    ),
    { code: 'target_unavailable' },
  );
const replaced = () =>
  Object.assign(
    new Error(
      'The shared library was replaced. Your captured work is retained for recovery.',
    ),
    { code: 'library_replaced' },
  );
const stale = () =>
  Object.assign(
    new Error(
      'The captured notes or library changed. Your content is retained for recovery.',
    ),
    { code: 'structure_changed' },
  );
/** Local acknowledgment is IndexedDB durability only, never server acceptance. */
export class DexieRepository implements Repository {
  private lastHistoryWrite: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private staged: { token: string; backup: BackupV8; epoch: string } | null =
    null;
  private closed = false;
  private boundEpoch: string | null = null;
  get viewEpoch() {
    return this.boundEpoch;
  }
  /** Only after a validated transfer installed its matching pointer atomically. */
  bindTransferredEpoch(epoch: string) {
    if (this.boundEpoch !== null) throw stale();
    this.boundEpoch = epoch;
  }
  private viewKey() {
    return `library-view:${this.libraryId}`;
  }
  private requireEpoch() {
    if (!this.boundEpoch) throw new Error('Load the workspace before editing.');
    return this.boundEpoch;
  }
  readonly libraryId: string;
  constructor(
    readonly db: ScratchtreeDatabase,
    private files: BackupFiles,
    libraryId?: string,
    private readonly neverBound = false,
  ) {
    if (db.cloudEnabled && !libraryId)
      throw new Error('A cloud library identity is required.');
    this.libraryId = libraryId ?? 'local';
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new Error('Repository is closed.');
      return fn();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private tables() {
    return [
      this.db.notes,
      this.db.orders,
      this.db.purges,
      this.db.libraries,
      this.db.witnesses,
      this.db.drafts,
      this.db.undo,
      this.db.recovery,
      this.db.pending,
      this.db.device,
    ];
  }
  /** Only a Session that opened the never-bound plain store may settle local receipts.
   * The activation, transaction witness, and applied flag must still agree in this transaction. */
  async settleLocalWrites() {
    if (!this.neverBound) return;
    await this.db.transaction(
      'rw',
      [this.db.device, this.db.pending, this.db.witnesses, this.db.recovery],
      async () => {
        if ((await readActivation(this.db)).mode !== 'local') return;
        const pending = await this.db.pending.toArray();
        const witnesses = await this.db.witnesses.bulkGet(
          pending.map((p) => p.id),
        );
        const completed = pending.filter((p, i) => {
          const w = witnesses[i];
          return (
            p.localApplied &&
            w &&
            w.epoch === p.epoch &&
            w.digest === p.digest &&
            w.recordedAt === p.recordedAt
          );
        });
        if (!completed.length) return;
        const ids = new Set(completed.map((p) => p.id));
        const retainedSources = new Set(
          pending
            .filter((p) => !ids.has(p.id))
            .flatMap((p) => {
              const source = sourceOfIntent(p);
              return source ? [sourceHeadKey(p.epoch, source.id)] : [];
            }),
        );
        const sources = new Map<string, Set<string>>();
        for (const p of completed) {
          const source = sourceOfIntent(p);
          if (!source) continue;
          const key = sourceHeadKey(p.epoch, source.id);
          if (retainedSources.has(key)) continue;
          const texts = sources.get(key) ?? new Set();
          texts.add(source.markdown);
          sources.set(key, texts);
        }
        await this.db.pending.bulkDelete([...ids]);
        await this.db.witnesses.bulkDelete([...ids]);
        await this.db.device.bulkDelete([...sources.keys()]);
        if (sources.size) {
          const removable = (await this.db.recovery.toArray()).filter(
            (r) =>
              r.kind === 'source' &&
              r.reason === 'unknown' &&
              sources
                .get(sourceHeadKey(r.originEpoch, r.itemId))
                ?.has(r.markdown),
          );
          await this.db.recovery.bulkDelete(removable.map((r) => r.id));
        }
      },
    );
  }
  private async initialize() {
    await this.db.open();
    await this.db.transaction('rw', this.db.libraries, async () => {
      if (!(await this.db.libraries.get(this.libraryId))) {
        if (this.db.cloudEnabled)
          throw new Error('The shared library has not been initialized.');
        await this.db.libraries.add({
          id: this.libraryId,
          epoch: crypto.randomUUID(),
        });
      }
    });
  }
  private async sharedRows(epoch: string) {
    const [notes, orders, purges] = await Promise.all([
      this.db.notes.where('epoch').equals(epoch).toArray(),
      this.db.orders.where('epoch').equals(epoch).toArray(),
      this.db.purges.where('epoch').equals(epoch).toArray(),
    ]);
    return {
      epoch,
      notes: notes.map(providerFields),
      orders: orders.map(providerFields),
      purges: purges.map(providerFields),
    };
  }
  private async read(
    capturedEpoch?: string,
    allowRawBuffers = false,
    projection?: ReturnType<typeof projectLibrary>,
  ): Promise<CheckedState> {
    if (
      !allowRawBuffers &&
      (await this.db.device.where('key').startsWith(RAW_BUFFER_PREFIX).count())
    )
      throw new Error('Raw input needs recovery adoption.');
    const library = await this.db.libraries.get(this.libraryId);
    if (!library) throw stale();
    const epoch = capturedEpoch ?? library.epoch;
    const [drafts, undo, recovery] = await Promise.all([
      this.db.drafts.where('epoch').equals(epoch).toArray(),
      this.db.undo.get(epoch),
      this.db.recovery.toArray(),
    ]);
    if (!projection) {
      const shared = await this.sharedRows(epoch);
      projection = projectLibrary(
        shared.notes,
        shared.orders,
        shared.purges,
        epoch,
      );
    }
    const projected = projection;
    const snapshot: WorkspaceSnapshot = {
      items: projected.items,
      drafts: drafts.map(({ epoch: _epoch, ...draft }) => draft),
      undoDeleteIds: undo?.ids ?? [],
    };
    // Remote purge/replacement must preserve orphaned checkpoints before pruning them.
    const ids = new Set(snapshot.items.map((x) => x.id));
    snapshot.drafts = snapshot.drafts.filter((d) => {
      const owner =
        d.key.startsWith('compose:') && d.key !== 'compose:trash'
          ? d.key.slice(8)
          : d.key === 'compose' || d.key === 'compose:trash'
            ? null
            : d.key;
      if (owner === null || ids.has(owner)) return true;
      const existing = recovery.find(
        (x) =>
          x.kind === 'draft' &&
          x.reason === 'purged' &&
          x.originEpoch === epoch &&
          x.draftKey === d.key,
      );
      if (existing && existing.kind === 'draft') existing.markdown = d.markdown;
      else
        recovery.push({
          id: crypto.randomUUID(),
          kind: 'draft',
          draftKey: d.key,
          markdown: d.markdown,
          reason: 'purged',
          originEpoch: epoch,
          recordedAt: Date.now(),
        });
      return false;
    });
    const facts = new Map(undo?.facts.map((x) => [x.id, x]) ?? []),
      actual = new Map(undoFacts(snapshot).map((x) => [x.id, x]));
    snapshot.undoDeleteIds = snapshot.undoDeleteIds.filter((id) => {
      const item = actual.get(id),
        old = facts.get(id);
      return (
        item?.deletedAt != null &&
        (!old ||
          (item.deletedAt === old.deletedAt &&
            item.restoreParentId === old.restoreParentId &&
            item.restoreIndex === old.restoreIndex))
      );
    });
    const state = {
      epoch,
      snapshot,
      purgedIds: projected.purgedIds,
      recovery,
      undo,
    };
    const { byteLength: backupBytes } = serializeCloudBackup(
      this.backupOf(state),
    );
    return { ...state, backupBytes };
  }
  private backupOf(state: State) {
    return {
      library: { items: state.snapshot.items, purgedIds: state.purgedIds },
      device: {
        drafts: state.snapshot.drafts,
        undoDeleteIds: state.snapshot.undoDeleteIds,
        recovery: state.recovery,
      },
    };
  }
  private encode(state: State) {
    return encodeCloudBackup(this.backupOf(state));
  }
  private checkMutation(
    before: CheckedState,
    after: State,
    indexed?: IndexedChanges,
  ) {
    if (indexed)
      validateIndexedBackup(
        this.backupOf(before),
        before.backupBytes,
        this.backupOf(after),
        indexed.items,
      );
    else this.encode(after);
  }
  private async local(state: State, markView = true) {
    const existing = await this.db.drafts
        .where('epoch')
        .equals(state.epoch)
        .toArray(),
      wanted = new Map(state.snapshot.drafts.map((x) => [x.key, x]));
    for (const old of existing)
      if (!wanted.has(old.key))
        await this.db.drafts.delete([state.epoch, old.key]);
    const existingByKey = new Map(existing.map((x) => [x.key, x]));
    for (const d of state.snapshot.drafts) {
      const old = existingByKey.get(d.key);
      if (!old || !equal({ ...d, epoch: state.epoch }, old))
        await this.db.drafts.put({ ...d, epoch: state.epoch });
    }
    const facts = undoFacts(state.snapshot);
    const undo = {
      epoch: state.epoch,
      ids: state.snapshot.undoDeleteIds,
      facts,
    };
    if (!equal(state.undo, undo)) await this.db.undo.put(undo);
    for (const record of state.recovery) await this.db.recovery.put(record);
    if (markView)
      await this.db.device.put({
        key: this.viewKey(),
        value: { epoch: state.epoch, snapshot: state.snapshot },
      });
  }
  /** Compute the complete prospective view without consuming checkpoints or advancing the marker. */
  private async prepareAdoption(current: State, rawInputs: RawBuffer[]) {
    const markers: DeviceRow[] = [];
    const marker = (await this.db.device.get(this.viewKey()))?.value as
      { epoch: string; snapshot: WorkspaceSnapshot } | undefined;
    // read() already validated this view before any adoption work.
    if (!rawInputs.length && (!marker || marker.epoch === current.epoch))
      return markers;
    if (
      marker &&
      marker.epoch !== current.epoch &&
      !current.recovery.some(
        (x) => x.kind === 'library' && x.originEpoch === marker.epoch,
      )
    ) {
      let retired: WorkspaceSnapshot;
      try {
        retired = (await this.read(marker.epoch, true)).snapshot;
      } catch {
        retired = marker.snapshot;
      }
      if (
        retired.items.length ||
        retired.drafts.length ||
        (await this.db.pending.where('epoch').equals(marker.epoch).count())
      )
        current.recovery.push({
          id: crypto.randomUUID(),
          kind: 'library',
          snapshot: retired,
          reason: 'replaced',
          originEpoch: marker.epoch,
          recordedAt: Date.now(),
        });
    }
    for (const input of rawInputs) {
      const owner = composeOwner(input.key),
        id = owner ? owner.ownerId : input.key;
      if (
        input.epoch === current.epoch &&
        (id === null || current.snapshot.items.some((item) => item.id === id))
      ) {
        const existing = current.snapshot.drafts.find(
          (d) => d.key === input.key,
        );
        if (!existing || existing.revision < input.revision) {
          current.snapshot.drafts = current.snapshot.drafts.filter(
            (d) => d.key !== input.key,
          );
          current.snapshot.drafts.push({
            key: input.key,
            markdown: input.markdown,
            revision: input.revision,
            updatedAt: input.recordedAt,
          });
        }
      } else {
        const alternative = { ...current, epoch: input.epoch };
        await this.retainRejectedDraft(
          alternative,
          input,
          input.recordedAt,
          markers,
        );
        current.recovery = alternative.recovery;
      }
    }
    this.encode(current);
    return markers;
  }
  assessView() {
    return this.db.transaction('r', this.tables(), async () => {
      const pointer = await this.db.libraries.get(this.libraryId);
      if (!pointer) throw stale();
      const shared = await this.sharedRows(pointer.epoch);
      let view: ReturnType<typeof projectLibrary>;
      try {
        view = projectLibrary(
          shared.notes,
          shared.orders,
          shared.purges,
          shared.epoch,
        );
        encodeCloudBackup({
          library: { items: view.items, purgedIds: view.purgedIds },
          device: { drafts: [], undoDeleteIds: [], recovery: [] },
        });
      } catch (error) {
        return {
          kind:
            error instanceof LibraryCapacityError
              ? ('shared-capacity' as const)
              : ('invalid-shared' as const),
          shared,
        };
      }
      try {
        const current = await this.read(shared.epoch, true, view);
        const buffers = await readRawBuffers(this.db);
        await this.prepareAdoption(current, buffers);
        const marker = (await this.db.device.get(this.viewKey()))?.value as
          { epoch: string } | undefined;
        return {
          kind:
            buffers.length || (marker && marker.epoch !== shared.epoch)
              ? ('adoption' as const)
              : ('ready' as const),
          shared,
          ...view,
          recoveries: current.recovery.length,
          pendingCount: await this.db.pending.count(),
        };
      } catch (error) {
        if (!(error instanceof LibraryCapacityError)) throw error;
        return { kind: 'device-capacity' as const, shared };
      }
    });
  }
  private async adoptRemote(buffers: RemoteBuffer[] = []) {
    await this.initialize();
    const state = await this.db.transaction('rw', this.tables(), async () => {
      let current = await this.read(undefined, true);
      const rawInputs = await readRawBuffers(this.db);
      const ids = new Set(current.snapshot.items.map((item) => item.id));
      for (const input of buffers) {
        const origin = input.originEpoch ?? this.boundEpoch ?? current.epoch;
        const owner = composeOwner(input.key);
        const id = owner ? owner.ownerId : input.key;
        if (origin === current.epoch && (id === null || ids.has(id))) continue;
        if (!Number.isSafeInteger(input.revision) || input.revision < 0)
          throw new Error('Invalid draft revision.');
        const retired =
          origin === current.epoch ? current : await this.read(origin, true);
        await this.retainRejectedDraft(retired, input, Date.now());
        await this.persistRecovery(retired);
        current = await this.read(undefined, true);
      }
      const markers = await this.prepareAdoption(current, rawInputs);
      for (const marker of markers) await this.db.device.put(marker);
      await this.local(current);
      for (const input of rawInputs)
        await this.db.device.delete(rawBufferKey(input.epoch, input.key));
      return current;
    });
    this.boundEpoch = state.epoch;
    return state;
  }
  loadWorkspace() {
    return this.serial(async () => (await this.adoptRemote()).snapshot);
  }
  readBoundWorkspace(epoch: string) {
    return this.serial(() =>
      this.db.transaction('r', this.tables(), async () => {
        if (
          this.boundEpoch !== epoch ||
          (await this.db.libraries.get(this.libraryId))?.epoch !== epoch
        )
          throw replaced();
        return (await this.read(epoch)).snapshot;
      }),
    );
  }
  refreshFromRemote(buffers: RemoteBuffer[]): Promise<RemoteRefresh> {
    const captured = structuredClone(buffers);
    return this.serial(async () => {
      const originEpoch =
        this.boundEpoch ?? (await this.readCurrentEpochUnqueued());
      const marker = (await this.db.device.get(this.viewKey()))?.value as
        { epoch: string; snapshot: WorkspaceSnapshot } | undefined;
      let state: State;
      try {
        state = await this.adoptRemote(captured);
      } catch (error) {
        await retainRawBuffers(this.db, captured, originEpoch);
        throw error;
      }
      const currentIds = new Set(state.snapshot.items.map((item) => item.id));
      return {
        workspace: state.snapshot,
        originEpoch,
        replaced: originEpoch !== state.epoch,
        removedIds: (marker?.snapshot.items ?? [])
          .filter((item) => !currentIds.has(item.id))
          .map((item) => item.id),
      };
    });
  }
  private async readCurrentEpochUnqueued() {
    await this.initialize();
    const row = await this.db.libraries.get(this.libraryId);
    if (!row) throw stale();
    return row.epoch;
  }
  /** Protected local transfer; does not adopt a newer remote epoch or touch dialogs. */
  readTransfer() {
    return this.serial(async () =>
      this.db.transaction('rw', this.tables(), async () => {
        const epoch = this.requireEpoch();
        if ((await this.db.libraries.get(this.libraryId))?.epoch !== epoch)
          throw replaced();
        const state = await this.read(epoch);
        const checked = validateCloudBackup(this.encode(state));
        if ('code' in checked) throw new Error(checked.message);
        return {
          epoch,
          backup: checked,
          purges: (
            await this.db.purges.where('epoch').equals(epoch).toArray()
          ).map(providerFields),
          pending: orderedIntents(await this.db.pending.toArray()),
          journal: await readJournalMetadata(this.db),
          archived: await readArchive(this.db),
        };
      }),
    );
  }
  /** Install a reconciled branch only while the pulled shared library is still exactly current.
   * The transaction writes field deltas, original witnesses, and protected local facts together. */
  adoptTransfer(
    expected: { epoch: string; library: BackupV8['library'] } | null,
    t: Transfer,
    admitted: PendingIntent[],
  ) {
    return this.serial(async () => {
      await this.db.transaction('rw', this.tables(), async () => {
        const pointer = await this.db.libraries.get(this.libraryId);
        if ((pointer?.epoch ?? null) !== (expected?.epoch ?? null))
          throw stale();
        const before: State = pointer
          ? await this.read()
          : {
              epoch: t.epoch,
              snapshot: emptyWorkspace(),
              purgedIds: [],
              recovery: [],
            };
        if (
          expected &&
          (!equal(before.snapshot.items, expected.library.items) ||
            !equal(before.purgedIds, expected.library.purgedIds))
        )
          throw stale();
        const replacing = before.epoch !== t.epoch;
        if (
          replacing &&
          (before.snapshot.items.length || before.purgedIds.length) &&
          !admitted.some(
            (p) =>
              p.command.kind === 'replaceLibrary' &&
              p.command.previousEpoch === before.epoch &&
              p.command.newEpoch === t.epoch,
          )
        )
          throw stale();
        if (!pointer)
          await this.db.libraries.add({ id: this.libraryId, epoch: t.epoch });
        else if (replacing) {
          const changed = await this.db.libraries
            .where('id')
            .equals(this.libraryId)
            .and((row) => row.epoch === before.epoch)
            .modify({ epoch: t.epoch });
          if (changed !== 1) throw stale();
        }
        const next: State = {
          epoch: t.epoch,
          snapshot: snapshotOf(t.backup),
          purgedIds: t.backup.library.purgedIds,
          recovery: t.backup.device.recovery,
        };
        this.encode(next);
        await this.persist(
          replacing
            ? {
                epoch: t.epoch,
                snapshot: emptyWorkspace(),
                purgedIds: [],
                recovery: [],
              }
            : before,
          next,
          admitted.at(-1)?.recordedAt ?? 0,
          new Map(t.purges.map((p) => [p.id, p.purgedAt])),
        );
        await installDevice(this.db, t);
        for (const p of admitted)
          await this.db.witnesses.put({
            id: p.id,
            epoch: p.epoch,
            digest: p.digest,
            recordedAt: p.recordedAt,
          });
      });
      this.boundEpoch = t.epoch;
    });
  }
  /** A same-epoch instance swap must retain late old-editor input without overlaying the new note. */
  archiveSwitchedBuffers(buffers: RemoteBuffer[], originEpoch: string) {
    return this.serial(() =>
      this.db.transaction('rw', this.tables(), async () => {
        const current = await this.read();
        const archived = { ...current, epoch: originEpoch };
        for (const b of buffers)
          await this.retainRejectedDraft(archived, b, Date.now());
        this.encode(archived);
        await this.persistRecovery(archived);
      }),
    );
  }
  /** Epoch of the last acknowledged view; reading this never adopts a remote replacement. */
  getEpoch() {
    return this.serial(async () => this.requireEpoch());
  }
  /** Current raw pointer, for background detection only. */
  readCurrentEpoch() {
    return this.serial(async () => {
      await this.initialize();
      const row = await this.db.libraries.get(this.libraryId);
      if (!row) throw stale();
      return row.epoch;
    });
  }
  subscribeInvalidation(listener: () => void) {
    const subscription = liveQuery(async () => {
      const pointer = await this.db.libraries.get(this.libraryId);
      if (!pointer) return null;
      return Promise.all([
        this.db.notes.where('epoch').equals(pointer.epoch).toArray(),
        this.db.orders.where('epoch').equals(pointer.epoch).toArray(),
        this.db.purges.where('epoch').equals(pointer.epoch).toArray(),
        pointer,
      ]);
    }).subscribe({ next: () => listener() });
    return () => subscription.unsubscribe();
  }
  close() {
    this.closed = true;
    this.db.close();
  }
  private retainSource(
    state: State,
    source: { itemId: string; markdown: string },
    recordedAt: number,
    reason: RecoveryRecord['reason'] = 'unknown',
  ) {
    const existing = state.recovery.find(
      (record) =>
        record.kind === 'source' &&
        record.originEpoch === state.epoch &&
        record.itemId === source.itemId,
    );
    if (existing && existing.kind === 'source')
      Object.assign(existing, {
        markdown: source.markdown,
        recordedAt,
        reason,
      });
    else
      state.recovery.push({
        id: crypto.randomUUID(),
        kind: 'source',
        ...source,
        originEpoch: state.epoch,
        recordedAt,
        reason,
      });
  }
  private async retainRejectedSource(
    state: State,
    command: Extract<IntentCommand, { kind: 'saveItemSource' }>,
    recordedAt: number,
  ) {
    if (
      command.draft.key !== command.id ||
      !Number.isSafeInteger(command.draft.revision) ||
      command.draft.revision < 0
    )
      throw new Error('Invalid draft acknowledgment.');
    const key = `source-recovery:${canonicalJson([state.epoch, command.id, command.draft.key])}`;
    const marker = (await this.db.device.get(key))?.value as
      { id?: unknown; revision?: unknown } | undefined;
    const sources = state.recovery.filter(
      (record) =>
        record.kind === 'source' &&
        record.originEpoch === state.epoch &&
        record.itemId === command.id,
    );
    const existing =
      sources.find((record) => record.id === marker?.id) ?? sources[0];
    const candidate: RecoveryRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      kind: 'source',
      itemId: command.id,
      markdown: command.markdown,
      originEpoch: state.epoch,
      recordedAt,
      reason: state.purgedIds.includes(command.id) ? 'purged' : 'rejected',
    };
    const recovery = existing
      ? state.recovery.map((record) =>
          record.id === existing.id ? candidate : record,
        )
      : [...state.recovery, candidate];
    // A stale request must still satisfy the strict source/envelope contract.
    this.encode({ ...state, recovery });
    if (
      existing &&
      marker?.id === existing.id &&
      Number.isSafeInteger(marker.revision) &&
      (marker.revision as number) >= command.draft.revision
    )
      return;
    state.recovery = recovery;
    await this.db.device.put({
      key,
      value: { id: candidate.id, revision: command.draft.revision },
    });
  }
  private async retainRejectedDraft(
    state: State,
    input: { key: string; markdown: string; revision: number },
    recordedAt: number,
    markers?: DeviceRow[],
  ) {
    const key = `draft-recovery:${canonicalJson([state.epoch, input.key])}`;
    const marker = (await this.db.device.get(key))?.value as
      { id?: unknown; revision?: unknown } | undefined;
    const existing =
      typeof marker?.id === 'string'
        ? state.recovery.find(
            (record) =>
              record.id === marker.id &&
              record.kind === 'draft' &&
              record.reason === 'rejected' &&
              record.originEpoch === state.epoch &&
              record.draftKey === input.key,
          )
        : undefined;
    const candidate: RecoveryRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      kind: 'draft',
      draftKey: input.key,
      markdown: input.markdown,
      reason: 'rejected',
      originEpoch: state.epoch,
      recordedAt,
    };
    const recovery = existing
      ? state.recovery.map((record) =>
          record.id === existing.id ? candidate : record,
        )
      : [...state.recovery, candidate];
    // Validate every supplied payload, including stale requests, before writing.
    this.encode({ ...state, recovery });
    if (
      existing &&
      Number.isSafeInteger(marker?.revision) &&
      (marker!.revision as number) >= input.revision
    )
      return;
    state.recovery = recovery;
    const nextMarker = {
      key,
      value: { id: candidate.id, revision: input.revision },
    };
    if (markers) markers.push(nextMarker);
    else await this.db.device.put(nextMarker);
  }
  private async persistRecovery(state: State) {
    this.encode(state);
    for (const record of state.recovery) await this.db.recovery.put(record);
  }
  private localMutation(
    fn: (s: WorkspaceSnapshot) => void,
    preserveCheckpoint?: { key: string; markdown: string; revision: number },
  ) {
    const capturedEpoch = this.boundEpoch;
    return this.serial(async () => {
      await this.initialize();
      const commandEpoch = capturedEpoch ?? this.requireEpoch();
      let result: {
        snapshot: WorkspaceSnapshot;
        changed: boolean;
        unavailable?: boolean;
      };
      try {
        result = await this.db.transaction('rw', this.tables(), async () => {
          const pointer = await this.db.libraries.get(this.libraryId),
            changed = pointer?.epoch !== commandEpoch;
          if (changed && !preserveCheckpoint) throw replaced();
          const state = await this.read(commandEpoch);
          if (preserveCheckpoint) {
            if (
              !Number.isSafeInteger(preserveCheckpoint.revision) ||
              preserveCheckpoint.revision < 0
            )
              throw new Error('Invalid draft revision.');
            const owner = composeOwner(preserveCheckpoint.key),
              ownerId = owner ? owner.ownerId : preserveCheckpoint.key;
            if (
              ownerId !== null &&
              !state.snapshot.items.some((item) => item.id === ownerId)
            ) {
              await this.retainRejectedDraft(
                state,
                preserveCheckpoint,
                Date.now(),
              );
              await this.persistRecovery(state);
              return { snapshot: state.snapshot, changed, unavailable: true };
            }
          }
          fn(state.snapshot);
          if (changed)
            for (const draft of state.snapshot.drafts) {
              const existing = state.recovery.find(
                (x) =>
                  x.kind === 'draft' &&
                  x.originEpoch === commandEpoch &&
                  x.draftKey === draft.key,
              );
              if (existing && existing.kind === 'draft')
                existing.markdown = draft.markdown;
              else
                state.recovery.push({
                  id: crypto.randomUUID(),
                  kind: 'draft',
                  draftKey: draft.key,
                  markdown: draft.markdown,
                  reason: 'replaced',
                  originEpoch: commandEpoch,
                  recordedAt: Date.now(),
                });
            }
          this.encode(state);
          await this.local(state, !changed);
          return { snapshot: state.snapshot, changed, unavailable: false };
        });
      } catch (error) {
        let exceptional = false;
        try {
          exceptional = (await this.assessView()).kind !== 'ready';
        } catch {
          exceptional = true;
        }
        if (exceptional && preserveCheckpoint)
          await retainRawBuffers(this.db, [preserveCheckpoint], commandEpoch);
        throw error;
      }
      if (result.changed) throw replaced();
      if (result.unavailable) throw unavailable();
      return result.snapshot;
    });
  }
  checkpointDraft(key: string, markdown: string, revision: number) {
    return this.localMutation(
      (s) => {
        const draft: Draft = { key, markdown, revision, updatedAt: Date.now() };
        const probe = structuredClone(s);
        probe.drafts = probe.drafts.filter((d) => d.key !== key);
        probe.drafts.push(draft);
        encodeCloudBackup({
          library: { items: probe.items, purgedIds: [] },
          device: {
            drafts: probe.drafts,
            undoDeleteIds: probe.undoDeleteIds,
            recovery: [],
          },
        });
        const old = s.drafts.find((d) => d.key === key);
        if (!old || revision > old.revision) {
          s.drafts = s.drafts.filter((d) => d.key !== key);
          s.drafts.push(draft);
        }
      },
      { key, markdown, revision },
    );
  }
  discardDraft(key: string) {
    return this.localMutation((s) => {
      s.drafts = s.drafts.filter((d) => d.key !== key);
    });
  }
  private apply(
    s: WorkspaceSnapshot,
    c: IntentCommand,
    replay = false,
  ): string[] {
    switch (c.kind) {
      case 'replaceLibrary':
        throw new Error('Library replacement requires a staged restore.');
      case 'saveItemSource':
        rules.saveItemSource(s, c.id, c.markdown, c.draft);
        break;
      case 'captureItem':
        rules.captureItem(s, c.request);
        break;
      case 'createChildTree':
        rules.createChildTree(s, c.request);
        break;
      case 'promoteItem':
        rules.promoteItem(s, c.id);
        break;
      case 'deleteItem':
        rules.deleteItem(s, c.id, c.leave, c.attempt, replay);
        break;
      case 'purgeItem':
        return rules.purgeItem(s, c.request);
      case 'transitionLocation':
        rules.transitionLocation(s, c.request);
        break;
      case 'moveItems':
        rules.moveItems(s, c.request, replay);
        break;
      case 'restoreItem':
        rules.restoreItem(s, c.id);
        break;
      case 'applyHistory':
        applyCapturedHistory(s, c.request, replay);
        break;
      case 'undoDelete':
        rules.undoDelete(s, c.request);
        break;
      case 'setItemDone':
        rules.setItemDone(s, c.id, c.done);
        break;
      case 'setItemsDone':
        rules.setItemsDone(s, c.ids, c.done);
        break;
      case 'setItemColor':
        rules.setItemColor(s, c.id, c.color);
        break;
      case 'reorderItem':
        rules.reorderItem(s, c.request, replay);
        break;
    }
    return [];
  }
  private async discardRejectedHistory(
    intent: PendingIntent | undefined,
    error: unknown,
  ) {
    const rejected =
      error instanceof ChangedHistory ||
      (error instanceof Error &&
        'code' in error &&
        error.code === 'structure_changed');
    if (
      !intent ||
      intent.localApplied ||
      !historyOperationId(intent.command) ||
      !rejected
    )
      return;
    await this.db.transaction(
      'rw',
      [this.db.pending, this.db.witnesses],
      async () => {
        const current = await this.db.pending.get(intent.id);
        if (
          current &&
          !current.localApplied &&
          current.digest === intent.digest &&
          !(await this.db.witnesses.get(intent.id))
        )
          await this.db.pending.delete(intent.id);
      },
    );
  }
  private async expected(
    before: WorkspaceSnapshot,
    after: WorkspaceSnapshot,
    purgedIds: string[],
    indexed?: IndexedChanges,
  ): Promise<ExpectedOutcome> {
    const items: ExpectedOutcome['items'] = [];
    for (const { id, before: previous, after: value } of indexed?.items ??
      itemChanges(before, after)) {
      const structural = (item: Item) =>
        rules.structuralItems({
          items: [item],
          drafts: [],
          undoDeleteIds: [],
        })[0];
      const identity = { id, digest: await digest(value ?? null) };
      if (!previous && value)
        items.push({
          ...identity,
          kind: 'create',
          structural: structural(value),
          item: value,
        });
      else if (previous && !value)
        items.push({
          ...identity,
          kind: 'purge',
          structural: null,
          before: structural(previous),
        });
      else if (previous && value) {
        const fields: ItemFieldDeltas = {};
        for (const key of [
          'kind',
          'done',
          'color',
          'position',
          'updatedAt',
        ] as const)
          if (!equal(previous[key], value[key]))
            Object.assign(fields, {
              [key]: { before: previous[key], after: value[key] },
            });
        items.push({
          ...identity,
          kind: 'update',
          structural: structural(value),
          fields,
          ...(!equal(placement(previous), placement(value))
            ? {
                placement: {
                  before: placement(previous),
                  after: placement(value),
                },
              }
            : {}),
          ...(previous.markdown !== value.markdown
            ? {
                source: {
                  beforeDigest: await digest(previous.markdown),
                  afterDigest: await digest(value.markdown),
                },
              }
            : {}),
        });
      }
    }
    const priorOrders = new Map(
      orders(before, '', indexed?.orderGroups).map((x) => [x.id, x]),
    );
    const nextOrders = new Map(
      orders(after, '', indexed?.orderGroups).map((x) => [x.id, x]),
    );
    const expectedOrders = [
      ...new Set([...priorOrders.keys(), ...nextOrders.keys()]),
    ]
      .filter((id) => !equal(priorOrders.get(id), nextOrders.get(id)))
      .map((id) => {
        const row = nextOrders.get(id) ?? priorOrders.get(id)!;
        return {
          group: { scope: row.scope, itemId: row.parentId },
          ids: nextOrders.get(id)?.ids ?? [],
        };
      });
    return { items, purgedIds, orders: expectedOrders };
  }
  private outcomeMatches(
    state: State,
    expected: ExpectedOutcome,
    command: IntentCommand,
  ): boolean {
    const items = new Map(state.snapshot.items.map((item) => [item.id, item]));
    return (
      expected.purgedIds.every((id) => state.purgedIds.includes(id)) &&
      expected.items.every((outcome) => {
        const actual = items.get(outcome.id);
        if (outcome.kind === 'purge')
          return !actual && state.purgedIds.includes(outcome.id);
        if (!actual) return false;
        if (outcome.kind === 'create') return equal(actual, outcome.item);
        if (
          outcome.placement &&
          !equal(placement(actual), outcome.placement.after)
        )
          return false;
        if (
          outcome.source &&
          (command.kind !== 'saveItemSource' ||
            command.id !== outcome.id ||
            actual.markdown !== command.markdown)
        )
          return false;
        return (Object.keys(outcome.fields) as (keyof ItemFieldDeltas)[]).every(
          (key) =>
            key === 'updatedAt' ||
            equal(actual[key], outcome.fields[key]!.after),
        );
      })
    );
  }
  private async persist(
    before: State,
    after: State,
    capturedAt = Date.now(),
    purgeTimes?: Map<string, number>,
    indexed?: IndexedChanges,
  ) {
    const oldItems = indexed
      ? indexed.items.flatMap(({ before: item }) => (item ? [item] : []))
      : before.snapshot.items;
    const newItems = indexed
      ? indexed.items.flatMap(({ after: item }) => (item ? [item] : []))
      : after.snapshot.items;
    const previous = new Map(oldItems.map((x) => [x.id, x]));
    for (const item of newItems) {
      const old = previous.get(item.id),
        key: [string, string] = [after.epoch, item.id];
      if (!old) {
        await this.db.notes.add(share(item, after.epoch));
        continue;
      }
      if (!indexed && sameItem(old, item)) continue;
      const from = share(old, after.epoch),
        to = share(item, after.epoch);
      const changes: Record<string, unknown> = {};
      for (const property of [
        'kind',
        'markdown',
        'done',
        'color',
        'createdAt',
        'updatedAt',
        'placement',
      ] as const)
        if (!equal(from[property], to[property]))
          changes[property] = to[property];
      if (Object.keys(changes).length) await this.db.notes.update(key, changes);
    }
    for (const id of after.purgedIds)
      if (!before.purgedIds.includes(id)) {
        await this.db.notes.delete([after.epoch, id]);
        await this.db.purges.put({
          id,
          epoch: after.epoch,
          purgedAt: purgeTimes?.get(id) ?? capturedAt,
        });
      }
    const oldOrders = new Map(
        orders(before.snapshot, before.epoch, indexed?.orderGroups).map((x) => [
          x.id,
          x,
        ]),
      ),
      newOrders = new Map(
        orders(after.snapshot, after.epoch, indexed?.orderGroups).map((x) => [
          x.id,
          x,
        ]),
      );
    for (const id of new Set([...oldOrders.keys(), ...newOrders.keys()])) {
      const row = newOrders.get(id);
      if (!equal(row, oldOrders.get(id))) {
        if (row) await this.db.orders.put(row);
        else await this.db.orders.delete([after.epoch, id]);
      }
    }
    await this.local(after);
  }
  private mutate(
    command: IntentCommand,
  ): Promise<{ workspace: WorkspaceSnapshot; removedIds: string[] }> {
    command = structuredClone(command);
    const capturedEpoch = this.boundEpoch;
    return this.serial(async () => {
      await this.initialize();
      const commandEpoch = capturedEpoch ?? this.requireEpoch();
      const capturedAt = Date.now();
      const before = await this.db.transaction('r', this.tables(), () =>
        this.read(commandEpoch),
      );
      const fingerprint = await digest({ epoch: before.epoch, command });
      const tracked = !!historyOperationId(command);
      if (tracked && fingerprint === this.lastHistoryWrite) {
        this.apply(before.snapshot, command, true);
        return { workspace: before.snapshot, removedIds: [] };
      }
      if (
        command.kind === 'saveItemSource' &&
        !before.snapshot.items.some((item) => item.id === command.id)
      ) {
        await this.db.transaction('rw', this.tables(), async () => {
          const rejected = await this.read(commandEpoch);
          await this.retainRejectedSource(rejected, command, capturedAt);
          await this.persistRecovery(rejected);
        });
        if (
          (await this.db.libraries.get(this.libraryId))?.epoch !== commandEpoch
        )
          throw replaced();
        throw unavailable();
      }
      const candidates = (
        await this.db.pending.where('fingerprint').equals(fingerprint).toArray()
      ).sort((a, b) => b.recordedAt - a.recordedAt);
      let pending = tracked
        ? candidates[0]
        : candidates.find((x) => !x.localApplied);
      const useIndex = !candidates.length && canIndex(command, before.snapshot);
      const after = copyMutation(before, useIndex);
      let removedIds: string[];
      try {
        removedIds = this.apply(
          after.snapshot,
          command,
          pending?.localApplied ?? false,
        );
      } catch (error) {
        await this.discardRejectedHistory(pending, error);
        throw error;
      }
      if (
        (command.kind === 'captureItem' &&
          before.purgedIds.includes(command.request.id)) ||
        (command.kind === 'createChildTree' &&
          before.purgedIds.includes(command.request.id))
      )
        throw stale();
      after.purgedIds = [...new Set([...after.purgedIds, ...removedIds])];
      if (
        candidates.length &&
        !pending &&
        equal(before.snapshot.items, after.snapshot.items)
      )
        pending = candidates.find((x) =>
          this.outcomeMatches(before, x.expected, x.command),
        );
      // Latest source is recovery material even before the shared transaction can run.
      const source =
        command.kind === 'saveItemSource'
          ? { itemId: command.id, markdown: command.markdown }
          : command.kind === 'captureItem'
            ? { itemId: command.request.id, markdown: command.request.markdown }
            : command.kind === 'createChildTree'
              ? { itemId: command.request.id, markdown: 'Untitled' }
              : null;
      if (source) this.retainSource(after, source, capturedAt);
      const indexed = useIndex
        ? indexedChanges(before.snapshot, after.snapshot)
        : undefined;
      this.checkMutation(before, after, indexed);
      if (!pending) {
        const expected = await this.expected(
          before.snapshot,
          after.snapshot,
          removedIds,
          indexed,
        );
        if (tracked) {
          const [start, finish] = await Promise.all([
            digest(rules.structuralItems(before.snapshot)),
            digest(rules.structuralItems(after.snapshot)),
          ]);
          expected.structure = { before: start, after: finish };
        }
        pending = {
          id: crypto.randomUUID(),
          epoch: before.epoch,
          fingerprint,
          digest: await digest({ command, expected }),
          recordedAt: capturedAt,
          command,
          expected,
          localApplied: false,
          sequence: 0,
        };
      }
      const intent = pending;
      await this.db.transaction(
        'rw',
        this.db.pending,
        this.db.recovery,
        this.db.device,
        async () => {
          const current = await this.db.pending.toArray();
          if (
            (!current.some((x) => x.id === intent.id) &&
              current.length >= 1000) ||
            bytes([...current.filter((x) => x.id !== intent.id), intent]) >
              MAX_ENVELOPE
          )
            throw new Error(
              'Pending recovery capacity reached. Export recovery before continuing.',
            );
          await preservePendingIntent(this.db, intent);
          for (const record of after.recovery)
            await this.db.recovery.put(record);
        },
      );
      const commit = this.db.transaction('rw', this.tables(), async () => {
        if (
          (await this.db.libraries.get(this.libraryId))?.epoch !== intent.epoch
        )
          throw replaced();
        const fresh = await this.read();
        if (fresh.epoch !== intent.epoch) throw replaced();
        const indexFresh = useIndex && canIndex(intent.command, fresh.snapshot);
        const next = copyMutation(fresh, indexFresh);
        const acknowledgedReplay =
          intent.localApplied &&
          this.outcomeMatches(fresh, intent.expected, intent.command);
        const removed = this.apply(
          next.snapshot,
          intent.command,
          intent.localApplied,
        );
        if (!acknowledgedReplay) {
          const priorItems = new Map(
            fresh.snapshot.items.map((item) => [item.id, item]),
          );
          const nextPositions = new Map(
            next.snapshot.items.map((item, index) => [item.id, index]),
          );
          for (const outcome of intent.expected.items) {
            const actual = priorItems.get(outcome.id) ?? null;
            const at = nextPositions.get(outcome.id) ?? -1;
            if (outcome.kind === 'create') {
              if (actual !== null && !equal(actual, outcome.item))
                throw stale();
              if (at >= 0)
                next.snapshot.items[at] = structuredClone(outcome.item);
            } else if (outcome.kind === 'update') {
              if (actual === null || at < 0) throw stale();
              const target = next.snapshot.items[at];
              if (outcome.placement) {
                const actualPlacement = placement(actual);
                if (
                  !equal(actualPlacement, outcome.placement.before) &&
                  !equal(actualPlacement, outcome.placement.after)
                )
                  throw stale();
                Object.assign(target, outcome.placement.after);
              }
              for (const key of ['kind', 'position'] as const) {
                const change = outcome.fields[key];
                if (
                  change &&
                  !equal(actual[key], change.before) &&
                  !equal(actual[key], change.after)
                )
                  throw stale();
              }
              for (const key of Object.keys(
                outcome.fields,
              ) as (keyof ItemFieldDeltas)[]) {
                const change = outcome.fields[key]!;
                Object.assign(target, {
                  [key]:
                    key === 'updatedAt'
                      ? Math.max(actual.updatedAt, change.after as number)
                      : change.after,
                });
              }
            }
          }
        }
        next.purgedIds = [...new Set([...fresh.purgedIds, ...removed])];
        const changes = indexFresh
          ? indexedChanges(fresh.snapshot, next.snapshot)
          : undefined;
        this.checkMutation(fresh, next, changes);
        await this.persist(fresh, next, intent.recordedAt, undefined, changes);
        await this.db.witnesses.put({
          id: intent.id,
          epoch: intent.epoch,
          digest: intent.digest,
          recordedAt: intent.recordedAt,
        });
        await this.db.pending.update(intent.id, { localApplied: true });
        await this.settleLocalWrites();
        return { workspace: next.snapshot, removedIds: removed };
      });
      const result = await commit.catch(async (error: unknown) => {
        await this.discardRejectedHistory(intent, error);
        throw error;
      });
      if (tracked) this.lastHistoryWrite = fingerprint;
      return result;
    });
  }
  saveItemSource(id: string, markdown: string, draft: DraftAck) {
    return this.mutate({ kind: 'saveItemSource', id, markdown, draft }).then(
      (x) => x.workspace,
    );
  }
  captureItem(request: CaptureItem) {
    return this.mutate({ kind: 'captureItem', request }).then(
      (x) => x.workspace,
    );
  }
  createChildTree(request: CreateChildTree) {
    return this.mutate({ kind: 'createChildTree', request }).then(
      (x) => x.workspace,
    );
  }
  promoteItem(id: string) {
    return this.mutate({ kind: 'promoteItem', id }).then((x) => x.workspace);
  }
  deleteItem(id: string, leave?: Location, attempt?: DeleteAttempt) {
    return this.mutate({
      kind: 'deleteItem',
      id,
      ...(leave ? { leave } : {}),
      ...(attempt ? { attempt } : {}),
    }).then((x) => x.workspace);
  }
  purgeItem(request: PurgeRequest) {
    return this.mutate({ kind: 'purgeItem', request });
  }
  transitionLocation(request: TransitionLocation) {
    return this.mutate({ kind: 'transitionLocation', request }).then(
      (x) => x.workspace,
    );
  }
  moveItems(request: MoveItems) {
    return this.mutate({ kind: 'moveItems', request }).then((x) => x.workspace);
  }
  restoreItem(id: string) {
    return this.mutate({ kind: 'restoreItem', id }).then((x) => x.workspace);
  }
  undoDelete(request: UndoDeleteRequest) {
    return this.mutate({ kind: 'undoDelete', request }).then(
      (x) => x.workspace,
    );
  }
  applyHistory(request: HistoryRequest) {
    return this.mutate({ kind: 'applyHistory', request }).then(
      (x) => x.workspace,
    );
  }
  setItemDone(id: string, done: boolean) {
    return this.mutate({ kind: 'setItemDone', id, done }).then(
      (x) => x.workspace,
    );
  }
  setItemsDone(ids: string[], done: boolean) {
    return this.mutate({ kind: 'setItemsDone', ids, done }).then(
      (x) => x.workspace,
    );
  }
  setItemColor(id: string, color: ColorToken | null) {
    return this.mutate({ kind: 'setItemColor', id, color }).then(
      (x) => x.workspace,
    );
  }
  reorderItem(request: ReorderItem) {
    return this.mutate({ kind: 'reorderItem', request }).then(
      (x) => x.workspace,
    );
  }
  exportBackup() {
    return this.serial(async () => {
      await this.initialize();
      const text = await this.db.transaction('r', this.tables(), async () =>
        this.encode(await this.read()),
      );
      return this.files.chooseWrite(text);
    });
  }
  previewRestore(): Promise<RestorePreview | null> {
    return this.serial(async () => {
      const text = await this.files.chooseRead();
      if (text === null) return null;
      const backup = validateCloudBackup(text);
      if ('code' in backup) throw new Error(backup.message);
      const token = crypto.randomUUID();
      this.staged = {
        token,
        backup: structuredClone(backup),
        epoch: crypto.randomUUID(),
      };
      return {
        token,
        notes: backup.library.items.filter((x) => x.kind === 'note').length,
        trees: backup.library.items.filter((x) => x.kind === 'tree').length,
        drafts: backup.device.drafts.length,
        warning:
          this.files.restoreWarning ??
          'This replaces the shared notes on every device. Current local work is retained for recovery.',
      };
    });
  }
  confirmRestore(
    token: string,
    confirm: boolean,
  ): Promise<WorkspaceSnapshot | null> {
    const capturedEpoch = this.boundEpoch;
    return this.serial(async () => {
      if (!this.staged || token !== this.staged.token)
        throw new Error('The restore preview expired.');
      if (!confirm) {
        this.staged = null;
        return null;
      }
      await this.initialize();
      const staged = structuredClone(this.staged.backup),
        old = await this.db.transaction('r', this.tables(), () => this.read());
      if (old.epoch !== (capturedEpoch ?? this.requireEpoch()))
        throw replaced();
      await this.files.writeSafety(this.encode(old));
      const newEpoch = this.staged.epoch;
      const command: IntentCommand = {
        kind: 'replaceLibrary',
        previousEpoch: old.epoch,
        newEpoch,
        backup: staged,
      };
      const fingerprint = await digest({ epoch: newEpoch, command });
      const existing = await this.db.pending
        .where('fingerprint')
        .equals(fingerprint)
        .first();
      const expected: ExpectedOutcome = {
        items: [],
        purgedIds: [...staged.library.purgedIds],
        orders: orders(
          { items: staged.library.items, drafts: [], undoDeleteIds: [] },
          newEpoch,
        ).map((x) => ({
          group: { scope: x.scope, itemId: x.parentId },
          ids: x.ids,
        })),
      };
      const intent: PendingIntent = existing ?? {
        id: crypto.randomUUID(),
        epoch: newEpoch,
        fingerprint,
        command,
        expected,
        digest: await digest({ command, expected }),
        recordedAt: Date.now(),
        localApplied: false,
        sequence: 0,
      };
      await this.db.transaction(
        'rw',
        [this.db.pending, this.db.device],
        async () => {
          const rows = await this.db.pending.toArray();
          if (
            (!existing && rows.length >= 1000) ||
            bytes([...rows.filter((x) => x.id !== intent.id), intent]) >
              MAX_ENVELOPE
          )
            throw new Error('Pending recovery capacity reached.');
          await preservePendingIntent(this.db, intent);
        },
      );
      const result = await this.db.transaction(
        'rw',
        this.tables(),
        async () => {
          const fresh = await this.read();
          if (fresh.epoch !== old.epoch || !equal(fresh, old)) throw stale();
          const recovery = [...fresh.recovery];
          const used = new Map(
            recovery.map((record) => [record.id.toLowerCase(), record]),
          );
          for (const record of staged.device.recovery) {
            const existing = used.get(record.id.toLowerCase());
            if (existing && equal(existing, record)) continue;
            // Internal recovery IDs have no incoming references. A collision
            // keeps both payloads, assigning only the imported record a new ID.
            const imported = existing
              ? { ...record, id: crypto.randomUUID() }
              : record;
            recovery.push(imported);
            used.set(imported.id.toLowerCase(), imported);
          }
          if (
            fresh.snapshot.items.length ||
            fresh.snapshot.drafts.length ||
            (await this.db.pending.where('epoch').equals(fresh.epoch).count())
          )
            recovery.push({
              id: crypto.randomUUID(),
              kind: 'library',
              snapshot: fresh.snapshot,
              reason: 'replaced',
              originEpoch: fresh.epoch,
              recordedAt: Date.now(),
            });
          const state: State = {
            epoch: newEpoch,
            snapshot: {
              items: staged.library.items,
              drafts: staged.device.drafts,
              undoDeleteIds: staged.device.undoDeleteIds,
            },
            purgedIds: staged.library.purgedIds,
            recovery,
          };
          this.encode(state);
          await this.db.libraries.put({
            id: this.libraryId,
            epoch: state.epoch,
          });
          await this.persist(
            {
              epoch: state.epoch,
              snapshot: emptyWorkspace(),
              purgedIds: [],
              recovery: [],
            },
            state,
            intent.recordedAt,
          );
          await this.db.witnesses.put({
            id: intent.id,
            epoch: newEpoch,
            digest: intent.digest,
            recordedAt: intent.recordedAt,
          });
          await this.db.pending.update(intent.id, { localApplied: true });
          await this.settleLocalWrites();
          return state.snapshot;
        },
      );
      this.staged = null;
      this.boundEpoch = newEpoch;
      return result;
    });
  }
}
