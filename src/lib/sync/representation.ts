import type { Item, WorkspaceSnapshot } from '../domain/notes';
import { scopeIndex } from '../domain/hierarchy';
import type { SharedItem, OrderRow } from './types';
export const toSharedItem = (item: Item, epoch: string): SharedItem => {
  const {
    parentId,
    position: _position,
    deletedAt,
    restoreParentId,
    restoreIndex,
    ...source
  } = item;
  return {
    ...source,
    epoch,
    placement: { parentId, deletedAt, restoreParentId, restoreIndex },
  };
};
export const orderGroupId = (item: Item) =>
  item.parentId ?? (item.deletedAt === null ? 'root:live' : 'root:trash');

export function orderRows(
  snapshot: WorkspaceSnapshot,
  epoch: string,
  affectedGroups?: ReadonlySet<string>,
): OrderRow[] {
  // Scoped callers read a canonical snapshot, then validate its prospective
  // hierarchy separately. Only Root needs distinct live and Trash rows.
  const scopes = affectedGroups ? null : scopeIndex(snapshot.items);
  const groups = new Map<string, OrderRow>();
  const positions = new Map<string, number>();
  for (const item of snapshot.items) {
    const scope =
      item.parentId === null
        ? (scopes?.get(item.id) ?? (item.deletedAt === null ? 'live' : 'trash'))
        : 'live';
    const id = orderGroupId(item);
    if (affectedGroups && !affectedGroups.has(id)) continue;
    const row = groups.get(id) ?? {
      id,
      epoch,
      parentId: item.parentId,
      scope,
      ids: [],
    };
    row.ids.push(item.id);
    groups.set(id, row);
    positions.set(item.id, item.position);
  }
  return [...groups.values()].map((x) => ({
    ...x,
    ids: x.ids.sort((a, b) => positions.get(a)! - positions.get(b)!),
  }));
}
