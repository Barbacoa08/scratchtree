import type { StructuralItem } from '../platform/workspace';
import { scopeIndex } from './hierarchy';
import type { Location, WorkspaceSnapshot } from './notes';

type Placement = Pick<
  StructuralItem,
  'parentId' | 'deletedAt' | 'restoreParentId' | 'restoreIndex'
>;
type Side = 'before' | 'after';
type Group = { location: Location; ids: string[] };
type PlacedNote = { id: string; placement: Placement };

export interface HistoryEdit {
  ids: string[];
  groups: Record<Side, Group[]>;
  placements: Record<Side, PlacedNote[]>;
  subtrees: Record<Side, PlacedNote[]> | null;
}

export interface HistoryRequest {
  id: string;
  actionId: string;
  edit: HistoryEdit;
  direction: 'undo' | 'redo';
  deletion: boolean;
}

export class ChangedHistory extends Error {
  readonly code = 'history_changed';

  constructor() {
    super(
      'These notes or their locations changed. Scratchtree cleared workspace Undo and Redo.',
    );
  }
}

const placement = ({
  parentId,
  deletedAt,
  restoreParentId,
  restoreIndex,
}: StructuralItem): Placement => ({
  parentId,
  deletedAt,
  restoreParentId,
  restoreIndex,
});
const same = (a: Placement, b: Placement) =>
  a.parentId === b.parentId &&
  a.deletedAt === b.deletedAt &&
  a.restoreParentId === b.restoreParentId &&
  a.restoreIndex === b.restoreIndex;
const groupKey = ({ parentId, deletedAt }: StructuralItem) =>
  parentId ?? (deletedAt === null ? 'live' : 'trash');
const equalIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

function indexStructure(items: readonly StructuralItem[]) {
  const index = new Map(items.map((item) => [item.id, item]));
  const groups = new Map<string, StructuralItem[]>();
  for (const item of items) {
    const key = groupKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return { index, groups };
}

function subtree(
  structure: ReturnType<typeof indexStructure>,
  roots: readonly string[],
) {
  const result = new Map<string, Placement>();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop()!;
    const item = structure.index.get(id);
    if (!item || result.has(id)) continue;
    result.set(id, placement(item));
    for (const child of structure.groups.get(id) ?? []) pending.push(child.id);
  }
  return [...result].map(([id, placement]) => ({ id, placement }));
}

/** Keep only operation-owned placements and the sibling orders they affected. */
export function captureHistoryEdit(
  before: readonly StructuralItem[],
  after: readonly StructuralItem[],
  ids: readonly string[],
): HistoryEdit | null {
  const old = indexStructure(before);
  const next = indexStructure(after);
  const keys = new Set<string>();
  const changed = new Set(ids);
  for (const item of before) {
    const current = next.index.get(item.id);
    if (!current) return null;
    const moved = !same(placement(item), placement(current));
    if (moved) changed.add(item.id);
    if (moved || item.position !== current.position) {
      keys.add(groupKey(item));
      keys.add(groupKey(current));
    }
  }
  if (!keys.size) return null;
  const oldScopes = scopeIndex(before);
  const nextScopes = scopeIndex(after);
  const groupOrders = (
    structure: typeof old,
    scopes: typeof oldScopes,
  ): Group[] =>
    [...keys].map((key) => ({
      location: {
        scope: scopes.get(key) ?? (key === 'trash' ? 'trash' : 'live'),
        itemId: structure.index.has(key) ? key : null,
      },
      ids: (structure.groups.get(key) ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((item) => item.id),
    }));
  const placements = (structure: typeof old) =>
    [...changed].map((id) => ({
      id,
      placement: placement(structure.index.get(id)!),
    }));
  const crossesTrash = ids.some(
    (id) => oldScopes.get(id) !== nextScopes.get(id),
  );
  const groups = {
    before: groupOrders(old, oldScopes),
    after: groupOrders(next, nextScopes),
  };
  if (
    groups.before.every((group, i) =>
      equalIds(group.ids, groups.after[i].ids),
    ) &&
    [...changed].every((id) =>
      same(placement(old.index.get(id)!), placement(next.index.get(id)!)),
    )
  )
    return null;
  return {
    ids: [...ids],
    groups,
    placements: { before: placements(old), after: placements(next) },
    subtrees: crossesTrash
      ? {
          before: subtree(old, [...changed]),
          after: subtree(next, [...changed]),
        }
      : null,
  };
}

export function historyDestination(request: HistoryRequest) {
  return request.direction === 'undo' ? 'before' : 'after';
}

export function historyMatches(
  s: WorkspaceSnapshot,
  edit: HistoryEdit,
  side: Side,
) {
  const scopes = scopeIndex(s.items);
  const structure = indexStructure(s.items);
  for (const { location, ids } of edit.groups[side]) {
    if (
      location.itemId !== null &&
      scopes.get(location.itemId) !== location.scope
    )
      return false;
    const group = structure.groups.get(location.itemId ?? location.scope) ?? [];
    if (
      !equalIds(
        group
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((item) => item.id),
        ids,
      )
    )
      return false;
  }
  for (const { id, placement: expected } of edit.placements[side]) {
    const item = structure.index.get(id);
    if (
      !item ||
      scopes.get(id) === undefined ||
      (expected.restoreParentId !== null &&
        !structure.index.has(expected.restoreParentId)) ||
      !same(placement(item), expected)
    )
      return false;
  }
  if (edit.subtrees) {
    const actual = new Map(
      subtree(
        structure,
        edit.placements[side].map((item) => item.id),
      ).map(({ id, placement }) => [id, placement]),
    );
    const expected = edit.subtrees[side];
    if (
      actual.size !== expected.length ||
      expected.some(({ id, placement }) => {
        const found = actual.get(id);
        return !found || !same(found, placement);
      })
    )
      return false;
  }
  return true;
}

/** Apply inside the normal Repository mutation, where validation failure discards the copy. */
export function applyCapturedHistory(
  s: WorkspaceSnapshot,
  request: HistoryRequest,
  replay: boolean,
) {
  const { edit } = request;
  const to = historyDestination(request);
  const from = to === 'after' ? 'before' : 'after';
  if (!historyMatches(s, edit, replay ? to : from)) throw new ChangedHistory();
  if (replay) return;
  const index = new Map(s.items.map((item) => [item.id, item]));
  const targets = edit.ids.map((id) => index.get(id)!);
  const oldPositions = targets.map(({ position }) => position);
  for (const { id, placement } of edit.placements[to])
    Object.assign(index.get(id)!, placement);
  for (const { location, ids } of edit.groups[to]) {
    if (location.itemId !== null && ids.length)
      index.get(location.itemId)!.kind = 'tree';
    for (const [position, id] of ids.entries())
      index.get(id)!.position = position;
  }
  for (const [i, item] of targets.entries()) {
    if (
      item.position !== oldPositions[i] ||
      !same(placement(item), edit.placements[from][i].placement)
    )
      item.updatedAt = Math.max(
        Date.now(),
        item.updatedAt + 1,
        item.deletedAt ?? 0,
      );
  }
  s.undoDeleteIds =
    request.deletion && to === 'after'
      ? [...edit.ids]
      : s.undoDeleteIds.filter((id) => index.get(id)?.deletedAt != null);
  try {
    if (historyMatches(s, edit, to)) return;
  } catch {
    // The candidate would introduce an invalid parent edge or cycle.
  }
  throw new ChangedHistory();
}
