import type { Item } from './notes';

const retention = 180 * 24 * 60 * 60 * 1000;

/** For a validated hierarchy, return eligible notes with descendants first. */
export function expiredTrashIds(
  items: readonly Item[],
  now: number,
  protectedIds: ReadonlySet<string> = new Set(),
): string[] {
  const children = new Map<string | null, Item[]>();
  for (const item of items) {
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item);
    children.set(item.parentId, siblings);
  }
  const stack = (children.get(null) ?? []).map((item) => ({
    item,
    inherited: null as number | null,
  }));
  const checked: { item: Item; enteredAt: number | null }[] = [];
  while (stack.length) {
    const { item, inherited } = stack.pop()!;
    const deletedAt = item.deletedAt ?? inherited;
    checked.push({
      item,
      enteredAt:
        deletedAt === null ? null : Math.max(item.createdAt, deletedAt),
    });
    for (const child of children.get(item.id) ?? []) {
      stack.push({ item: child, inherited: deletedAt });
    }
  }
  const retained = new Set(protectedIds);
  const expired: string[] = [];
  for (let i = checked.length - 1; i >= 0; i--) {
    const { item, enteredAt } = checked[i];
    if (
      enteredAt !== null &&
      enteredAt < now - retention &&
      !retained.has(item.id)
    )
      expired.push(item.id);
    else if (item.parentId !== null) retained.add(item.parentId);
  }
  return expired;
}
