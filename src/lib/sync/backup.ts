import {
  MAX_ENVELOPE,
  MAX_SOURCE,
  type AppError,
  type Draft,
  type Item,
  type WorkspaceSnapshot,
} from '../domain/notes';
import { uuid, validateSnapshotStructure } from '../domain/validation';

type RecoveryFacts = {
  id: string;
  reason: 'rejected' | 'purged' | 'replaced' | 'detached-conflict' | 'unknown';
  originEpoch: string;
  recordedAt: number;
};
/** Portable device-only recovery; each variant retains exactly its own identity and content. */
export type RecoveryRecord = RecoveryFacts &
  (
    | { kind: 'source'; itemId: string; markdown: string }
    | { kind: 'draft'; draftKey: string; markdown: string }
    | { kind: 'library'; snapshot: WorkspaceSnapshot }
  );
export interface BackupV8 {
  format: 'scratchtree';
  version: 8;
  exportedAt: string;
  library: { items: Item[]; purgedIds: string[] };
  device: {
    drafts: Draft[];
    undoDeleteIds: string[];
    recovery: RecoveryRecord[];
  };
}
type BackupContents = Omit<BackupV8, 'format' | 'version' | 'exportedAt'>;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const invalid = (
  message = 'Invalid library fields or references.',
): AppError => ({ code: 'invalid_backup', message });
const markdown = (value: unknown): value is string =>
  typeof value === 'string' && bytes(value) <= MAX_SOURCE;
const draftKey = (value: unknown): value is string =>
  uuid(value) ||
  value === 'compose' ||
  value === 'compose:trash' ||
  (typeof value === 'string' &&
    value.startsWith('compose:') &&
    uuid(value.slice(8)));
function validRecovery(value: unknown): value is RecoveryRecord {
  if (
    !record(value) ||
    !uuid(value.id) ||
    ![
      'rejected',
      'purged',
      'replaced',
      'detached-conflict',
      'unknown',
    ].includes(value.reason as string) ||
    typeof value.originEpoch !== 'string' ||
    !value.originEpoch.length ||
    bytes(value.originEpoch) > 128 ||
    !Number.isSafeInteger(value.recordedAt) ||
    (value.recordedAt as number) < 0
  )
    return false;
  const common = ['id', 'reason', 'originEpoch', 'recordedAt', 'kind'];
  if (value.kind === 'source')
    return (
      fields(value, [...common, 'itemId', 'markdown']) &&
      uuid(value.itemId) &&
      markdown(value.markdown)
    );
  if (value.kind === 'draft')
    return (
      fields(value, [...common, 'draftKey', 'markdown']) &&
      draftKey(value.draftKey) &&
      markdown(value.markdown)
    );
  if (value.kind === 'library')
    return (
      fields(value, [...common, 'snapshot']) &&
      !('code' in validateSnapshotStructure(value.snapshot))
    );
  return false;
}
export function validateCloudBackup(text: string): BackupV8 | AppError {
  if (bytes(text) > MAX_ENVELOPE)
    return invalid('Backup exceeds the 10 MiB capacity.');
  const backup = decodeCloudBackup(text);
  if ('code' in backup) return backup;
  if (bytes(JSON.stringify(backup)) > MAX_ENVELOPE)
    return invalid(
      'Backup exceeds the 10 MiB capacity. The original is retained.',
    );
  return backup;
}

/** Decode the exact JSON payload after the caller has checked its input size. */
function decodeCloudBackup(text: string): BackupV8 | AppError {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid('Backup must be valid JSON.');
  }
  return validateBackupValue(value);
}

function validateBackupValue(value: unknown): BackupV8 | AppError {
  if (
    !record(value) ||
    !fields(value, ['format', 'version', 'exportedAt', 'library', 'device']) ||
    value.format !== 'scratchtree' ||
    value.version !== 8 ||
    typeof value.exportedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.exportedAt) ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    new Date(value.exportedAt).toISOString() !== value.exportedAt
  )
    return invalid();
  const library = value.library,
    device = value.device;
  if (
    !record(library) ||
    !fields(library, ['items', 'purgedIds']) ||
    !record(device) ||
    !fields(device, ['drafts', 'undoDeleteIds', 'recovery']) ||
    !Array.isArray(library.purgedIds) ||
    !Array.isArray(device.recovery)
  )
    return invalid();
  const snapshot = validateSnapshotStructure({
    items: library.items,
    drafts: device.drafts,
    undoDeleteIds: device.undoDeleteIds,
  });
  if ('code' in snapshot) return snapshot;
  const itemIds = new Set(snapshot.items.map((x) => x.id.toLowerCase()));
  const purged = new Set<string>();
  for (const id of library.purgedIds) {
    if (
      !uuid(id) ||
      itemIds.has(id.toLowerCase()) ||
      purged.has(id.toLowerCase())
    )
      return invalid();
    purged.add(id.toLowerCase());
  }
  const recovery = new Set<string>();
  for (const entry of device.recovery) {
    if (!validRecovery(entry) || recovery.has(entry.id.toLowerCase()))
      return invalid();
    recovery.add(entry.id.toLowerCase());
  }
  return value as unknown as BackupV8;
}
export class LibraryCapacityError extends Error {}
const envelope = (backup: BackupContents, exportedAt: string): BackupV8 => ({
  ...backup,
  format: 'scratchtree',
  version: 8,
  exportedAt,
});

function checkCapacity(byteLength: number) {
  if (byteLength > MAX_ENVELOPE)
    throw new LibraryCapacityError('Backup exceeds the 10 MiB capacity.');
}

export function serializeCloudBackup(
  backup: BackupContents,
  exportedAt = new Date().toISOString(),
) {
  const text = JSON.stringify(envelope(backup, exportedAt));
  const byteLength = bytes(text);
  checkCapacity(byteLength);
  const checked = decodeCloudBackup(text);
  if ('code' in checked) throw new Error(checked.message);
  return { text, byteLength };
}

export function encodeCloudBackup(backup: BackupContents, exportedAt?: string) {
  return serializeCloudBackup(backup, exportedAt).text;
}

/** The byte count must come from a freshly validated baseline. Compare the
 * envelope without its items, then account for each changed item and comma. */
export function validateIndexedBackup(
  before: BackupContents,
  beforeBytes: number,
  after: BackupContents,
  changes: readonly { before?: Item; after?: Item }[],
) {
  const commas = (items: Item[]) => Math.max(0, items.length - 1);
  // Valid export timestamps have a fixed serialized length.
  const exportedAt = new Date().toISOString();
  const withoutItems = (backup: BackupContents) =>
    jsonBytes(
      envelope(
        {
          ...backup,
          library: { ...backup.library, items: [] },
        },
        exportedAt,
      ),
    );
  let total =
    beforeBytes +
    commas(after.library.items) -
    commas(before.library.items) +
    withoutItems(after) -
    withoutItems(before);
  for (const change of changes) {
    if (change.before) total -= jsonBytes(change.before);
    if (change.after) total += jsonBytes(change.after);
  }
  checkCapacity(total);
  const checked = validateBackupValue(envelope(after, exportedAt));
  if ('code' in checked) throw new Error(checked.message);
  return total;
}
