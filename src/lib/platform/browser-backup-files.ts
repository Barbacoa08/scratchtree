import { MAX_ENVELOPE } from '../domain/notes';
import type { ScratchtreeDatabase } from '../sync/database';
import type { BackupFiles } from './backup-files';

const safetyKey = 'browser-restore-safety';

interface PreparedDownload {
  kind: 'backup' | 'previous';
  filename: string;
  url: string;
}

export interface BrowserBackupState {
  download: PreparedDownload | null;
  hasPreviousNotes: boolean;
}

export interface BrowserBackupFiles extends BackupFiles {
  stageRestoreFile(file: File): Promise<void>;
  discardRestoreFile(): void;
  preparePreviousNotesDownload(): Promise<void>;
  subscribe(listener: (state: BrowserBackupState) => void): () => void;
  dispose(): void;
}

export function createBrowserBackupFiles(
  db: ScratchtreeDatabase,
): BrowserBackupFiles {
  let staged: File | null = null;
  let disposed = false;
  let downloadRequest = 0;
  let state: BrowserBackupState = { download: null, hasPreviousNotes: false };
  const listeners = new Set<(state: BrowserBackupState) => void>();

  function publish(next: BrowserBackupState) {
    if (state.download && state.download !== next.download)
      URL.revokeObjectURL(state.download.url);
    state = next;
    for (const listener of listeners) listener(state);
  }

  function prepare(text: string, kind: PreparedDownload['kind']) {
    const filename =
      kind === 'previous'
        ? 'scratchtree-previous-notes.json'
        : 'scratchtree-backup.json';
    return {
      kind,
      filename,
      url: URL.createObjectURL(new Blob([text], { type: 'application/json' })),
    };
  }

  return {
    restoreWarning: 'This replaces the notes in this browser.',
    async stageRestoreFile(file) {
      if (!disposed) staged = file;
    },
    discardRestoreFile() {
      staged = null;
    },
    async chooseRead() {
      const file = staged;
      staged = null;
      if (!file) return null;
      if (file.size > MAX_ENVELOPE)
        throw new Error('Backup exceeds the 10 MiB capacity.');
      const buffer = await file.arrayBuffer();
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw new Error('Backup must be a valid UTF-8 file.');
      }
    },
    async chooseWrite(text) {
      if (disposed) return null;
      downloadRequest++;
      const download = prepare(text, 'backup');
      publish({ ...state, download });
      return download.filename;
    },
    async writeSafety(text) {
      if (disposed) throw new Error('The browser workspace closed.');
      try {
        if (new TextEncoder().encode(text).byteLength > MAX_ENVELOPE)
          throw new Error('Safety backup exceeds the 10 MiB capacity.');
        await db.transaction('rw', db.device, () =>
          db.device.put({ key: safetyKey, value: text }),
        );
      } catch {
        throw new Error(
          'Could not save the previous notes in this browser. Restore can be retried.',
        );
      }
      if (disposed) throw new Error('The browser workspace closed.');
      downloadRequest++;
      let download = state.download;
      if (download?.kind !== 'backup') {
        try {
          download = prepare(text, 'previous');
        } catch {
          // The saved copy remains available for another download attempt.
          download = null;
        }
      }
      publish({ download, hasPreviousNotes: true });
    },
    async preparePreviousNotesDownload() {
      if (disposed) return;
      const request = ++downloadRequest;
      const text = (await db.device.get(safetyKey))?.value;
      if (disposed || typeof text !== 'string') return;
      let download = state.download;
      try {
        if (request === downloadRequest) download = prepare(text, 'previous');
      } finally {
        publish({ download, hasPreviousNotes: true });
      }
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      staged = null;
      listeners.clear();
      publish({ download: null, hasPreviousNotes: false });
    },
  };
}
