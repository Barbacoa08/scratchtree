import { structuralItems } from '../domain/items';
import { uuid } from '../domain/validation';
import { MAX_ENVELOPE } from '../domain/notes';
import { encodeCloudBackup, type BackupV8 } from './backup';
import type { ScratchtreeDatabase } from './database';
import {
  canonicalJson,
  installJournalMetadata,
  sourceOfIntent,
  type JournalMetadata,
  type PendingIntent,
} from './intents';
import type { DexieRepository } from './repository';
import { orderRows, toSharedItem } from './representation';
export type Transfer = Awaited<ReturnType<DexieRepository['readTransfer']>>;
export interface Baseline {
  epoch: string;
  library: BackupV8['library'];
  pendingIds: string[];
}
export type Activation = {
  version: 1;
  mode: 'local' | 'attached' | 'detached';
  cleanupNeeded: boolean;
  account: string | null;
  baseline: Baseline | null;
};
const activationKey = 'session-activation';
const initial: Activation = {
  version: 1,
  mode: 'local',
  cleanupNeeded: false,
  account: null,
  baseline: null,
};
export async function readActivation(
  db: ScratchtreeDatabase,
): Promise<Activation> {
  const row = await db.device.get(activationKey);
  if (!row) return { ...initial };
  const state = row.value as Activation;
  if (
    !state ||
    Object.keys(state).sort().join(',') !==
      'account,baseline,cleanupNeeded,mode,version' ||
    state.version !== 1 ||
    !['local', 'detached', 'attached'].includes(state.mode) ||
    typeof state.cleanupNeeded !== 'boolean' ||
    (state.mode === 'local'
      ? state.account !== null
      : typeof state.account !== 'string' ||
        !/^[a-f0-9]{64}$/.test(state.account)) ||
    (state.mode === 'detached') !== !!state.baseline ||
    (state.mode === 'attached' && state.cleanupNeeded)
  )
    throw Error('Invalid local session. The existing notes were retained.');
  if (state.baseline) {
    const b = state.baseline;
    if (
      Object.keys(b).sort().join(',') !== 'epoch,library,pendingIds' ||
      typeof b.epoch !== 'string' ||
      !b.epoch.length ||
      new TextEncoder().encode(b.epoch).length > 128 ||
      !Array.isArray(b.pendingIds) ||
      b.pendingIds.length > 1000 ||
      !b.pendingIds.every(uuid) ||
      new Set(b.pendingIds).size !== b.pendingIds.length
    )
      throw Error('Invalid detached baseline.');
    encodeCloudBackup({
      library: b.library,
      device: { drafts: [], undoDeleteIds: [], recovery: [] },
    });
  }
  return state;
}
export const setActivation = (db: ScratchtreeDatabase, state: Activation) =>
  db.device.put({ key: activationKey, value: state });
export const snapshotOf = (b: BackupV8) => ({
  items: b.library.items,
  drafts: b.device.drafts,
  undoDeleteIds: b.device.undoDeleteIds,
});
export interface ArchivedIntent {
  account: string;
  reason: 'detached-conflict' | 'replaced';
  intent: PendingIntent;
}
const archiveKey = 'detached-archive';
export function checkArchive(rows: ArchivedIntent[]) {
  if (
    !Array.isArray(rows) ||
    rows.length > 1000 ||
    new TextEncoder().encode(JSON.stringify(rows)).length > MAX_ENVELOPE
  )
    throw Error(
      'Detached recovery capacity reached. The original notes were retained.',
    );
  const ids = new Set<string>();
  for (const r of rows) {
    if (
      !r ||
      Object.keys(r).sort().join(',') !== 'account,intent,reason' ||
      !/^[a-f0-9]{64}$/.test(r.account) ||
      !['detached-conflict', 'replaced'].includes(r.reason) ||
      !r.intent ||
      !uuid(r.intent.id) ||
      !Number.isSafeInteger(r.intent.sequence) ||
      r.intent.sequence < 1 ||
      typeof r.intent.epoch !== 'string' ||
      !r.intent.epoch.length ||
      !/^([a-f0-9]{64})$/.test(r.intent.digest) ||
      ids.has(r.intent.id)
    )
      throw Error('Invalid detached recovery journal.');
    ids.add(r.intent.id);
  }
  return rows;
}
export async function readArchive(
  db: ScratchtreeDatabase,
): Promise<ArchivedIntent[]> {
  return checkArchive(
    ((await db.device.get(archiveKey))?.value ?? []) as ArchivedIntent[],
  );
}
export function combineArchive(...lists: ArchivedIntent[][]) {
  const rows = new Map<string, ArchivedIntent>();
  for (const list of lists)
    for (const r of list) {
      const prior = rows.get(r.intent.id);
      if (prior && canonicalJson(prior) !== canonicalJson(r))
        throw Error('Conflicting detached operation identity.');
      rows.set(r.intent.id, r);
    }
  return checkArchive([...rows.values()]);
}
export function journalFor(
  metadata: JournalMetadata,
  pending: PendingIntent[],
): JournalMetadata {
  const keys = new Set(
    pending.flatMap((p) => {
      const s = sourceOfIntent(p);
      return s ? [canonicalJson([p.epoch, s.id])] : [];
    }),
  );
  return {
    sequence: metadata.sequence,
    sources: metadata.sources.filter((h) =>
      keys.has(canonicalJson([h.epoch, h.itemId])),
    ),
  };
}
/** Only device-owned application tables and explicitly named keys take part. Never copy SDK state. */
export async function installDevice(
  db: ScratchtreeDatabase,
  transfer: Transfer,
) {
  await db.pending.clear();
  await db.pending.bulkPut(transfer.pending);
  await db.device.where('key').startsWith('source-head:').delete();
  await installJournalMetadata(db, transfer.journal);
  await db.device.put({
    key: archiveKey,
    value: checkArchive(transfer.archived),
  });
}
export async function detach(
  db: ScratchtreeDatabase,
  t: Transfer,
  account: string,
) {
  if (db.cloudEnabled)
    throw Error('Detachment requires a local-only database.');
  const b = t.backup,
    s = snapshotOf(b);
  encodeCloudBackup(b);
  const epoch = t.epoch;
  const activation: Activation = {
    version: 1,
    mode: 'detached',
    account,
    cleanupNeeded: true,
    baseline: {
      epoch,
      library: b.library,
      pendingIds: t.pending.map((p) => p.id),
    },
  };
  // Replacing a plain staging copy and its activation is a single durable IDB commit.
  await db.transaction('rw', db.tables, async () => {
    for (const table of [
      db.notes,
      db.orders,
      db.purges,
      db.libraries,
      db.witnesses,
      db.drafts,
      db.undo,
      db.recovery,
    ])
      await table.clear();
    await db.device.where('key').startsWith('library-view:').delete();
    await db.device.where('key').startsWith('draft-recovery:').delete();
    await db.device.where('key').startsWith('raw-buffer:').delete();
    await db.libraries.add({ id: 'local', epoch });
    await db.notes.bulkAdd(s.items.map((i) => toSharedItem(i, epoch)));
    await db.orders.bulkAdd(orderRows(s, epoch));
    await db.purges.bulkAdd(t.purges);
    await db.drafts.bulkAdd(s.drafts.map((d) => ({ ...d, epoch })));
    const undo = new Set(s.undoDeleteIds);
    await db.undo.put({
      epoch,
      ids: s.undoDeleteIds,
      facts: structuralItems(s).filter((i) => undo.has(i.id)),
    });
    await db.recovery.bulkAdd(b.device.recovery);
    await installDevice(db, t);
    await setActivation(db, activation);
  });
  return activation;
}
