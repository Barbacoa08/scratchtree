import type {
  Repository,
  RestorePreview,
} from '../../src/lib/platform/workspace';
import {
  emptyWorkspace,
  type WorkspaceSnapshot,
} from '../../src/lib/domain/notes';
import * as items from '../../src/lib/domain/items';
import type {
  DraftAck,
  CaptureItem,
  CreateChildTree,
  ReorderItem,
  PurgeItem,
  MoveItems,
  TransitionLocation,
  UndoDeleteRequest,
} from '../../src/lib/platform/workspace';
import type { ColorToken, Location } from '../../src/lib/domain/notes';
import { validateBackup, backupFixture } from './backup';
import type { BackupV8 } from '../../src/lib/sync/backup';
export class MemoryRepository implements Repository {
  snapshot = emptyWorkspace();
  fail: string | null = null;
  delaySave: Promise<void> | null = null;
  delayCreate: Promise<void> | null = null;
  delayCheckpoint: Promise<void> | null = null;
  checkpointCalls = 0;
  failCheckpointCall: number | null = null;
  restoreText: string | null = null;
  exported: string | null = null;
  staged: WorkspaceSnapshot | null = null;
  private extras = {
    purgedIds: [] as string[],
    recovery: [] as BackupV8['device']['recovery'],
  };
  private stagedExtras: typeof this.extras | null = null;
  private envelope(s: WorkspaceSnapshot, extras = this.extras) {
    const backup = backupFixture(s);
    backup.library.purgedIds = extras.purgedIds;
    backup.device.recovery = extras.recovery;
    return backup;
  }
  cancelExport = false;
  cancelRestore = false;
  private check(op: string) {
    if (this.fail === op)
      throw {
        code: 'test_failure',
        message: 'Synthetic local ' + op + ' failure. Retry.',
      };
  }
  private commit(s: WorkspaceSnapshot, extras = this.extras) {
    const checked = validateBackup(JSON.stringify(this.envelope(s, extras)));
    if ('code' in checked) throw checked;
    this.snapshot = structuredClone(s);
    this.extras = structuredClone(extras);
    return structuredClone(s);
  }
  async loadWorkspace() {
    this.check('load');
    return structuredClone(this.snapshot);
  }
  async checkpointDraft(key: string, markdown: string, revision: number) {
    const call = ++this.checkpointCalls;
    await this.delayCheckpoint;
    if (call === this.failCheckpointCall)
      throw {
        code: 'test_failure',
        message: 'Synthetic local checkpoint failure. Retry.',
      };
    this.check('checkpoint');
    const s = structuredClone(this.snapshot);
    const probe = structuredClone(s);
    probe.drafts = probe.drafts.filter((d) => d.key !== key);
    probe.drafts.push({ key, markdown, revision, updatedAt: Date.now() });
    const valid = validateBackup(JSON.stringify(this.envelope(probe)));
    if ('code' in valid) throw valid;
    const old = s.drafts.find((d) => d.key === key);
    if (!old || revision > old.revision) {
      s.drafts = s.drafts.filter((d) => d.key !== key);
      s.drafts.push({ key, markdown, revision, updatedAt: Date.now() });
    }
    return this.commit(s);
  }
  private mutate(fn: (s: WorkspaceSnapshot) => void) {
    const s = structuredClone(this.snapshot);
    fn(s);
    return this.commit(s);
  }
  async saveItemSource(id: string, markdown: string, draft: DraftAck) {
    await this.delaySave;
    this.check('save');
    return this.mutate((s) => items.saveItemSource(s, id, markdown, draft));
  }
  async captureItem(request: CaptureItem) {
    await this.delaySave;
    this.check('save');
    return this.mutate((s) => items.captureItem(s, request));
  }
  async createChildTree(request: CreateChildTree) {
    await this.delayCreate;
    this.check('create');
    return this.mutate((s) => items.createChildTree(s, request));
  }
  async promoteItem(id: string) {
    this.check('promote');
    return this.mutate((s) => items.promoteItem(s, id));
  }
  async setItemDone(id: string, done: boolean) {
    this.check('completion');
    return this.mutate((s) => items.setItemDone(s, id, done));
  }
  async setItemColor(id: string, color: ColorToken | null) {
    this.check('color');
    return this.mutate((s) => items.setItemColor(s, id, color));
  }
  async reorderItem(request: ReorderItem) {
    this.check('reorder');
    return this.mutate((s) => items.reorderItem(s, request));
  }
  async discardDraft(key: string) {
    this.check('discard');
    return this.mutate(
      (s) => (s.drafts = s.drafts.filter((d) => d.key !== key)),
    );
  }
  async deleteItem(id: string, leave?: Location) {
    this.check('delete');
    return this.mutate((s) => items.deleteItem(s, id, leave));
  }
  async purgeItem(request: PurgeItem) {
    this.check('purge');
    const s = structuredClone(this.snapshot);
    const removedIds = items.purgeItem(s, request);
    return { workspace: this.commit(s), removedIds };
  }
  async transitionLocation(request: TransitionLocation) {
    this.check('navigate');
    return this.mutate((s) => items.transitionLocation(s, request));
  }
  async moveItems(request: MoveItems) {
    this.check('move');
    return this.mutate((s) => items.moveItems(s, request));
  }
  async restoreItem(id: string) {
    this.check('restore-item');
    return this.mutate((s) => items.restoreItem(s, id));
  }
  async undoDelete(request: UndoDeleteRequest) {
    this.check('undo');
    return this.mutate((s) => items.undoDelete(s, request));
  }
  async exportBackup() {
    this.check('export');
    if (this.cancelExport) return null;
    this.exported = JSON.stringify(this.envelope(this.snapshot));
    return 'synthetic-backup.json';
  }
  async previewRestore(): Promise<RestorePreview | null> {
    this.check('preview');
    if (this.cancelRestore || !this.restoreText) return null;
    const b = validateBackup(this.restoreText);
    if ('code' in b) throw b;
    this.staged = {
      items: b.library.items,
      drafts: b.device.drafts,
      undoDeleteIds: b.device.undoDeleteIds,
    };
    this.stagedExtras = {
      purgedIds: b.library.purgedIds,
      recovery: b.device.recovery,
    };
    return {
      token: 'synthetic-token',
      notes: b.library.items.length,
      drafts: b.device.drafts.length,
      trees: b.library.items.filter((x) => x.kind === 'tree').length,
      warning:
        'Replace the entire local library, including Trash and drafts. A safety backup will be written first.',
    };
  }
  async confirmRestore(_token: string, confirm: boolean) {
    this.check('restore');
    if (!confirm) {
      this.staged = null;
      this.stagedExtras = null;
      return null;
    }
    if (!this.staged) throw Error('No preview');
    const s = this.commit(this.staged, this.stagedExtras ?? undefined);
    this.staged = null;
    this.stagedExtras = null;
    return s;
  }
}
