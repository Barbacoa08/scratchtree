<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Workspace from './Workspace.svelte';
  import { getAppearance } from '../platform/appearance-context';
  import {
    applyWebUpdate,
    checkForWebUpdate,
    prepareOfflineShell,
  } from '../platform/browser-offline';
  import {
    openWebWorkspace,
    reorderPreview,
    type WebWorkspace,
  } from '../platform/web-workspace';
  import type { WorkspaceController } from '../workspace/controller';

  const appearance = getAppearance();

  let workspace = $state.raw<WebWorkspace>();
  let controller: WorkspaceController | undefined;
  let unsubscribe: (() => void) | undefined;
  let scope: AbortController;
  let opening = $state(false);
  let startup = $state('');
  let busy = $state(true);
  let parked = $state(false);
  let parking: Promise<void> | undefined;
  let preparing = $state(false);
  let offlineStatus = $state('');
  let checking = $state(false);
  let applying = $state(false);
  let updateReady = $state(false);
  let updateStatus = $state('');
  let applyButton: HTMLButtonElement | undefined = $state();
  let retryButton: HTMLButtonElement | undefined = $state();

  async function prepare() {
    if (preparing) return;
    preparing = true;
    try {
      await prepareOfflineShell();
      offlineStatus = 'Ready to reopen offline';
    } catch {
      offlineStatus =
        'Offline reopening is unavailable. You can keep editing in this tab.';
    } finally {
      preparing = false;
    }
  }

  function close() {
    unsubscribe?.();
    unsubscribe = undefined;
    controller = undefined;
    busy = true;
    workspace?.close();
    workspace = undefined;
  }

  async function open() {
    if (opening || workspace || scope.signal.aborted) return;
    const restoreFocus = retryButton === document.activeElement;
    startup = '';
    opening = true;
    try {
      const candidate = await openWebWorkspace(scope.signal);
      if (scope.signal.aborted) {
        candidate?.close();
        return;
      }
      if (candidate) {
        workspace = candidate;
        void prepare();
      } else startup = 'Scratchtree is open in another tab';
    } catch (error) {
      if (!scope.signal.aborted)
        startup =
          error instanceof Error
            ? error.message
            : 'Scratchtree could not open your local notes.';
    } finally {
      opening = false;
      if (restoreFocus && startup) {
        await tick();
        if (document.activeElement === document.body) retryButton?.focus();
      }
    }
  }

  function attachController(value: WorkspaceController) {
    controller = value;
    unsubscribe?.();
    unsubscribe = value.subscribe((state) => {
      busy =
        !state.loaded || state.operation !== null || state.preview !== null;
    });
  }

  function checkpointWhenHidden() {
    if (document.visibilityState === 'hidden' && !parked && !applying)
      void controller?.flush();
  }

  function leave(event: PageTransitionEvent) {
    if (applying) return;
    if (!event.persisted) {
      void controller?.flush();
      return;
    }
    if (!workspace || parking) return;
    parked = true;
    parking = (async () => {
      if (!controller || (await controller.flush())) close();
    })();
  }

  async function resume(event: PageTransitionEvent) {
    if (!event.persisted) return;
    await parking;
    parking = undefined;
    parked = false;
    if (!workspace) await open();
  }

  async function check() {
    if (checking || applying || preparing) return;
    // This explicit retry may fetch files for an interrupted first load.
    if (!navigator.serviceWorker?.controller) await prepare();
    if (!navigator.serviceWorker?.controller) return;
    checking = true;
    updateReady = false;
    updateStatus = 'Checking for updates…';
    try {
      updateReady = (await checkForWebUpdate()) === 'available';
      if (!updateReady && offlineStatus !== 'Ready to reopen offline')
        await prepare();
      updateStatus = updateReady
        ? 'Update available'
        : offlineStatus === 'Ready to reopen offline'
          ? 'Up to date'
          : offlineStatus;
    } catch {
      updateStatus = 'Could not check for updates. Try again.';
    } finally {
      checking = false;
    }
  }

  async function apply() {
    const editor = controller;
    if (!editor || !workspace || busy || applying || parked || !updateReady)
      return;
    applying = true;
    updateStatus = 'Applying update…';
    await tick();
    try {
      if (await applyWebUpdate(() => editor.flush())) return;
      updateStatus = 'Save your changes before applying the update.';
    } catch {
      updateStatus = 'Could not apply the update. Try again.';
    }
    applying = false;
    await tick();
    if (document.activeElement === document.body) applyButton?.focus();
  }

  onMount(() => {
    scope = new AbortController();
    void open();
    document.addEventListener('visibilitychange', checkpointWhenHidden);
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', resume);
    return () => {
      scope.abort();
      close();
      document.removeEventListener('visibilitychange', checkpointWhenHidden);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', resume);
    };
  });
</script>

{#snippet webActions()}
  {#if reorderPreview}<p>Synthetic comparison data</p>{/if}
  <button onclick={check} disabled={preparing || checking || applying}
    >Check for updates</button
  >
  {#if updateReady}<button
      bind:this={applyButton}
      onclick={apply}
      disabled={busy || applying}>Apply update</button
    >{/if}
  <p role="status">{updateStatus || offlineStatus}</p>
{/snippet}

{#if workspace}
  {#key workspace}
    <Workspace
      repository={workspace.repository}
      browserBackup={workspace.backup}
      {webActions}
      webSuspended={applying || parked}
      appearance={appearance.preference}
      onappearancechange={appearance.setPreference}
      onready={attachController}
    />
  {/key}
{:else}
  <main class="web-opening" aria-busy={opening}>
    {#if startup}
      <h1>{startup}</h1>
      <button bind:this={retryButton} onclick={open}>Try again</button>
    {:else}
      <p role="status">Opening local notes…</p>
    {/if}
  </main>
{/if}

<style>
  .web-opening {
    display: block;
    max-width: 42rem;
    margin: 3rem auto;
    padding-inline: 1rem;
  }

  p[role='status'] {
    margin: 0;
  }
</style>
