import type { Item } from '../domain/notes';
import {
  composeOwner,
  directEntries,
  effectiveScope,
} from '../domain/hierarchy';
import { structuralItems } from '../domain/items';
import { validateSnapshot } from '../domain/validation';
import { encodeCloudBackup, type BackupV8 } from './backup';
import { snapshotOf, combineArchive, journalFor } from './detached';
import {
  canonicalJson,
  orderedIntents,
  sourceOfIntent,
  type PendingIntent,
} from './intents';
type Library = BackupV8['library'];
const snapshot = (items: Item[]) => ({ items, drafts: [], undoDeleteIds: [] });
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const structure = (lib: Library) => structuralItems(snapshot(lib.items));
function capturedAfter(before: Library, p: PendingIntent): Library {
  const result = structuredClone(before),
    map = new Map(result.items.map((i) => [i.id, i]));
  for (const delta of p.expected.items) {
    if (delta.kind === 'create') {
      map.set(delta.id, structuredClone(delta.item));
      continue;
    }
    if (delta.kind === 'purge') {
      map.delete(delta.id);
      continue;
    }
    const row = map.get(delta.id);
    if (!row) throw new Error('Incomplete detached operation history.');
    if (delta.placement) Object.assign(row, delta.placement.after);
    for (const [key, change] of Object.entries(delta.fields))
      Object.assign(row, {
        [key]:
          key === 'updatedAt'
            ? Math.max(row.updatedAt, Number(change.after))
            : change.after,
      });
    if (p.command.kind === 'saveItemSource' && p.command.id === row.id)
      row.markdown = p.command.markdown;
  }
  result.items = [...map.values()];
  result.purgedIds = [
    ...new Set([...result.purgedIds, ...p.expected.purgedIds]),
  ].sort();
  return result;
}
const fieldOf = (p: PendingIntent) =>
  p.command.kind === 'saveItemSource'
    ? 'markdown'
    : p.command.kind === 'setItemDone'
      ? 'done'
      : p.command.kind === 'setItemColor'
        ? 'color'
        : null;
/** Replay immutable outcomes in journal order. Use only the final detached edit to each field. */
export function planRejoin(
  base: Library,
  local: Library,
  cloud: Library,
  journal: PendingIntent[],
) {
  let cursor = structuredClone(base),
    library = structuredClone(cloud);
  const admitted: PendingIntent[] = [],
    conflicts: PendingIntent[] = [],
    ordered = orderedIntents(journal);
  const latest = new Map<string, PendingIntent>(),
    origins = new Map(base.items.map((i) => [i.id, i])),
    denied = new Set<string>();
  for (const p of ordered) {
    const field = fieldOf(p);
    if (field && 'id' in p.command) latest.set(p.command.id + field, p);
  }
  for (const p of ordered) {
    if (
      !p.localApplied ||
      p.command.kind === 'correctivePurge' ||
      p.command.kind === 'replaceLibrary'
    ) {
      conflicts.push(p);
      continue;
    }
    const before = cursor;
    cursor = capturedAfter(cursor, p);
    const command = p.command,
      field = fieldOf(p);
    if (field && 'id' in command) {
      if (denied.has(command.id)) {
        conflicts.push(p);
        continue;
      }
      if (latest.get(command.id + field) !== p) continue;
      const baseline = origins.get(command.id),
        target = library.items.find((i) => i.id === command.id),
        final = local.items.find((i) => i.id === command.id);
      if (
        !final ||
        (baseline && baseline[field] === final[field]) ||
        (target && target[field] === final[field])
      )
        continue;
      if (!baseline || !target || target[field] !== baseline[field]) {
        conflicts.push(p);
        continue;
      }
      Object.assign(target, { [field]: final[field] });
      const outcome = p.expected.items.find((i) => i.id === target.id);
      if (outcome?.kind === 'update' && outcome.fields.updatedAt)
        target.updatedAt = Math.max(
          target.updatedAt,
          outcome.fields.updatedAt.after,
        );
      admitted.push(p);
      continue;
    }
    if (command.kind === 'captureItem' || command.kind === 'createChildTree') {
      const id = command.request.id,
        creation = p.expected.items.find(
          (i) => i.kind === 'create' && i.id === id,
        );
      const rejectCreation = () => {
        denied.add(id);
        conflicts.push(p);
      };
      const existing = library.items.find(
        (i) => i.id.toLowerCase() === id.toLowerCase(),
      );
      if (creation?.kind !== 'create') {
        if (
          !existing ||
          !equal(
            existing,
            cursor.items.find((i) => i.id === id),
          )
        )
          rejectCreation();
        continue;
      }
      origins.set(id, creation.item);
      if (existing) {
        if (!equal(existing, creation.item)) rejectCreation();
        continue;
      }
      const at =
        command.kind === 'captureItem'
          ? command.request.location
          : command.request.parent;
      const parent = library.items.find((i) => i.id === at.itemId);
      if (
        library.purgedIds.some((x) => x.toLowerCase() === id.toLowerCase()) ||
        (at.itemId !== null &&
          (denied.has(at.itemId) ||
            !parent ||
            effectiveScope(library.items, parent.id) !== at.scope))
      ) {
        rejectCreation();
        continue;
      }
      // A leave can demote another tree. Require its exact structural precondition.
      if (
        command.kind === 'createChildTree' &&
        command.request.leave &&
        !equal(structure(before), structure(library))
      ) {
        rejectCreation();
        continue;
      }
      const ordinal = directEntries(snapshot(library.items), at).length;
      const next = capturedAfter(library, p);
      next.items.find((i) => i.id === id)!.position = ordinal;
      if ('code' in validateSnapshot(snapshot(next.items))) {
        rejectCreation();
        continue;
      }
      library = next;
      admitted.push(p);
      continue;
    }
    if (denied.size) {
      conflicts.push(p);
      continue;
    }
    // Structure includes exact parent edges, scope, deletion facts, kind, and sibling order.
    // This also fences old purges against previously unseen children.
    if (
      equal(structure(library), structure(cursor)) &&
      p.expected.purgedIds.every((id) => library.purgedIds.includes(id))
    )
      continue;
    if (
      !equal(structure(library), structure(before)) ||
      p.expected.items.some(
        (x) => x.kind === 'create' && library.purgedIds.includes(x.id),
      )
    ) {
      conflicts.push(p);
      continue;
    }
    library = capturedAfter(library, p);
    admitted.push(p);
  }
  return { library, admitted, conflicts };
}
/** Build portable device recovery; never leave a losing editor draft as an active overlay. */
export function reconcileTransfer(
  local: import('./detached').Transfer,
  remote: import('./detached').Transfer | null,
  baseline: import('./detached').Baseline | null,
  account: string,
) {
  const same = !!baseline && baseline.epoch === remote?.epoch;
  const old = new Set(baseline?.pendingIds ?? []);
  let admitted: PendingIntent[] = [],
    conflicts: PendingIntent[] = [],
    pending: PendingIntent[] = [],
    library: Library,
    epoch: string;
  const seeded =
    !baseline &&
    (!remote ||
      (!remote.backup.library.items.length &&
        !remote.backup.library.purgedIds.length &&
        (local.backup.library.items.length > 0 ||
          local.backup.library.purgedIds.length > 0)));
  const replacement = local.pending.find(
    (p) =>
      p.localApplied &&
      p.command.kind === 'replaceLibrary' &&
      p.command.previousEpoch === baseline?.epoch &&
      p.command.newEpoch === local.epoch,
  );
  const replace =
    !!replacement && same && equal(baseline?.library, remote?.backup.library);
  const sameBranch = same && local.epoch === remote?.epoch;
  if (!remote && !seeded)
    throw Error(
      'The synced library is unavailable. Your local notes are retained.',
    );
  if (seeded || replace) {
    epoch = local.epoch;
    library = local.backup.library;
    admitted = local.pending.filter(
      (p) =>
        p.localApplied &&
        p.epoch === epoch &&
        p.command.kind !== 'correctivePurge' &&
        !old.has(p.id),
    );
    pending = local.pending.filter((p) => p.epoch === epoch);
    conflicts = local.pending.filter((p) => p.epoch !== epoch);
  } else {
    epoch = remote!.epoch;
    library = remote!.backup.library;
    if (sameBranch) {
      const result = planRejoin(
        baseline!.library,
        local.backup.library,
        library,
        local.pending.filter((p) => p.epoch === epoch && !old.has(p.id)),
      );
      library = result.library;
      admitted = result.admitted;
      conflicts = [
        ...result.conflicts,
        ...local.pending.filter((p) => p.epoch !== epoch && !old.has(p.id)),
      ];
      // Prior unconfirmed commands travel only as existing receipts for the engine's
      // user-scoped server inspection. They never authorize a shared write or new witness.
      pending = [...local.pending.filter((p) => old.has(p.id)), ...admitted];
    } else conflicts = local.pending;
  }
  const recovery = structuredClone(local.backup.device.recovery);
  const common = {
    originEpoch: local.epoch,
    recordedAt: Date.now(),
    reason: 'detached-conflict' as const,
  };
  const losingBranch = !seeded && !sameBranch && !replace;
  const snapshot = snapshotOf(local.backup);
  if (
    (losingBranch || conflicts.some((p) => !sourceOfIntent(p))) &&
    (snapshot.items.length || snapshot.drafts.length || conflicts.length)
  )
    recovery.push({
      kind: 'library',
      id: crypto.randomUUID(),
      ...common,
      reason: losingBranch ? 'replaced' : 'detached-conflict',
      snapshot,
    });
  const byId = new Map(library.items.map((i) => [i.id, i])),
    localId = new Map(snapshot.items.map((i) => [i.id, i]));
  const drafts = snapshot.drafts.filter((d) => {
    const owner = composeOwner(d.key),
      id = owner ? owner.ownerId : d.key;
    if (
      !losingBranch &&
      (id === null || byId.has(id)) &&
      (owner || byId.get(d.key)?.markdown === localId.get(d.key)?.markdown)
    )
      return true;
    recovery.push({
      kind: 'draft',
      id: crypto.randomUUID(),
      draftKey: d.key,
      markdown: d.markdown,
      ...common,
    });
    return false;
  });
  for (const conflict of conflicts) {
    const source = sourceOfIntent(conflict);
    if (
      source &&
      !recovery.some(
        (r) =>
          r.kind === 'source' &&
          r.originEpoch === conflict.epoch &&
          r.itemId === source.id &&
          r.markdown === source.markdown,
      )
    )
      recovery.push({
        kind: 'source',
        id: crypto.randomUUID(),
        ...common,
        originEpoch: conflict.epoch,
        itemId: source.id,
        markdown: source.markdown,
      });
  }
  const undoDeleteIds = losingBranch
    ? []
    : snapshot.undoDeleteIds.filter((id) => {
        const a = localId.get(id),
          b = byId.get(id);
        return (
          a &&
          b &&
          b.deletedAt !== null &&
          a.deletedAt === b.deletedAt &&
          a.restoreIndex === b.restoreIndex &&
          a.restoreParentId === b.restoreParentId
        );
      });
  const archived = combineArchive(
    local.archived,
    conflicts.map((intent) => ({
      intent,
      account,
      reason: losingBranch ? 'replaced' : 'detached-conflict',
    })),
  );
  const backup = {
    ...local.backup,
    library,
    device: { drafts, undoDeleteIds, recovery },
  };
  encodeCloudBackup(backup);
  const purgeById = new Map(local.purges.map((row) => [row.id, row]));
  if (remote?.epoch === epoch)
    for (const row of remote.purges) purgeById.set(row.id, row);
  const purges = library.purgedIds.map((id) => {
    const row = purgeById.get(id);
    if (!row || row.epoch !== epoch)
      throw Error('Missing captured purge facts.');
    return row;
  });
  return {
    transfer: {
      purges,
      epoch,
      backup,
      pending,
      journal: journalFor(local.journal, pending),
      archived,
    },
    admitted,
  };
}
