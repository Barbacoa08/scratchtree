<script lang="ts">
  import { tick } from 'svelte';
  import type {
    BrowserBackupFiles,
    BrowserBackupState,
  } from '../platform/browser-backup-files';
  import type { WorkspaceController } from '../workspace/controller';
  import Icon from './Icon.svelte';

  let {
    backup,
    blocked,
    controller,
  }: {
    backup: BrowserBackupFiles;
    blocked: boolean;
    controller: WorkspaceController;
  } = $props();

  const previousDescription = $props.id();
  let picker: HTMLInputElement;
  let previousLink = $state<HTMLAnchorElement>();
  let backupState = $state<BrowserBackupState>({
    download: null,
    hasPreviousNotes: false,
  });
  let { download, hasPreviousNotes } = $derived(backupState);
  let working = $state(false);
  let downloadError = $state('');

  $effect(() => {
    const unsubscribe = backup.subscribe((next) => (backupState = next));
    void preparePrevious(backup);
    return unsubscribe;
  });

  async function preparePrevious(
    files: BrowserBackupFiles,
    trigger?: HTMLButtonElement,
  ) {
    const ownedFocus = document.activeElement === trigger;
    downloadError = '';
    try {
      await files.preparePreviousNotesDownload();
      await tick();
      if (ownedFocus && document.activeElement === document.body)
        previousLink?.focus();
    } catch {
      downloadError = 'Could not prepare the previous notes for download.';
    }
  }

  function openPicker() {
    if (blocked || working) return;
    picker.value = '';
    picker.click();
  }

  async function preview(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || blocked || working) return;
    working = true;
    const files = backup;
    try {
      await files.stageRestoreFile(file);
      await controller.previewRestore();
    } finally {
      files.discardRestoreFile();
      working = false;
    }
  }

  async function exportBackup() {
    if (blocked || working) return;
    working = true;
    try {
      await controller.export('Backup ready to download');
    } finally {
      working = false;
    }
  }
</script>

<button
  onclick={exportBackup}
  disabled={blocked && !working}
  aria-disabled={working || undefined}
>
  <Icon name="upload" /> Export backup
</button>
{#if download?.kind === 'backup'}
  <p class="previous-description" aria-hidden="true">
    Backup ready to download
  </p>
  <a
    href={download.url}
    download={download.filename}
    class="backup-download"
    inert={blocked}
  >
    <Icon name="download" /> Download backup
  </a>
{/if}
<button
  onclick={openPicker}
  disabled={blocked && !working}
  aria-disabled={working || undefined}
>
  <Icon name="download" /> Restore backup
</button>
<input
  bind:this={picker}
  type="file"
  accept=".json,application/json"
  onchange={preview}
  hidden
/>
{#if download?.kind === 'previous'}
  <a
    href={download.url}
    download={download.filename}
    class="backup-download"
    inert={blocked}
    bind:this={previousLink}
    aria-describedby={previousDescription}
  >
    <Icon name="download" /> Download previous notes
  </a>
{:else if hasPreviousNotes || downloadError}
  <button
    onclick={(event) => preparePrevious(backup, event.currentTarget)}
    disabled={blocked || working}
    aria-describedby={hasPreviousNotes ? previousDescription : undefined}
  >
    <Icon name="download" /> Prepare previous notes
  </button>
{/if}
{#if hasPreviousNotes}
  <p id={previousDescription} class="previous-description">
    This copy contains the notes saved before the latest confirmed restore
    attempt.
  </p>
{/if}
{#if downloadError}
  <p role="alert" class="previous-description">{downloadError}</p>
{/if}

<style>
  .backup-download {
    display: flex;
    align-items: center;
    min-height: 2rem;
    padding-left: calc(24px + 2px);
    gap: 0.3rem;
    color: var(--secondary);
    font-size: 0.8rem;
  }

  .backup-download:hover {
    color: var(--sidebar-hover-text);
  }

  .previous-description {
    margin: 0 0 0.25rem calc(24px + 2px);
    color: var(--secondary);
    font-size: 0.75rem;
  }
</style>
