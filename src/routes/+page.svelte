<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core';
  import { onMount, tick } from 'svelte';
  import { getAppearance } from '../lib/platform/appearance-context';
  import Workspace from '#lib/components/Workspace.svelte';
  import type { CloseAdapter } from '../lib/platform/lifecycle';
  import type { Repository } from '../lib/platform/workspace';
  import type { AuthPort, SyncPort } from '../lib/sync/service-types';
  import type { PersistentSession } from '../lib/sync/session';
  import type { WorkspaceController } from '../lib/workspace/controller';
  import { cloudConfiguration } from '../lib/sync/configuration';
  let auth: AuthPort | undefined = $state();
  let sync: SyncPort | undefined = $state();
  let repository: Repository | undefined = $state();
  let ready = $state<((c: WorkspaceController) => void) | undefined>();
  let windowAdapter: CloseAdapter | undefined = $state();
  const appearance = getAppearance();
  let phase = $state<'idle' | 'opening' | 'failed' | 'ready'>('idle');
  let retryButton = $state<HTMLButtonElement>();
  let localRecoveryButton = $state<HTMLButtonElement>();
  let showOpening = $state(false);
  let explainKeychain = $state(false);
  let openingController: AbortController | undefined;
  let session: PersistentSession | undefined;

  async function open(useLocalRecovery = false) {
    if (phase === 'opening' || phase === 'ready') return;
    const controller = new AbortController();
    openingController = controller;
    const initiatingButton = useLocalRecovery
      ? localRecoveryButton
      : retryButton;
    const restoreFocus = document.activeElement === initiatingButton;
    let newerFocus = false;
    function observeFocus(event: FocusEvent) {
      if (
        event.target instanceof Element &&
        event.target !== initiatingButton &&
        event.target !== document.body &&
        event.target !== document.documentElement
      )
        newerFocus = true;
    }
    if (restoreFocus)
      document.addEventListener('focusin', observeFocus, {
        signal: controller.signal,
      });

    showOpening = phase === 'failed';
    explainKeychain = false;
    phase = 'opening';
    const noticeTimer = setTimeout(() => {
      if (!controller.signal.aborted) showOpening = true;
    }, 500);
    try {
      const parameters = new URL(location.href).searchParams;
      if (import.meta.env.DEV && parameters.has('fixture')) {
        const fixture = await import('../../tests/fixtures/browser');
        controller.signal.throwIfAborted();
        repository = fixture.repository;
        ready = fixture.ready;
        if (parameters.has('lifecycle')) windowAdapter = fixture.windowAdapter;
        if (parameters.has('authFixture')) {
          const authFixture = await import('../../tests/fixtures/auth-ui');
          controller.signal.throwIfAborted();
          auth = authFixture.auth;
          sync = authFixture.sync;
          authFixture.install();
        }
      } else {
        const [{ PersistentSession }, { nativeBackupFiles }] =
          await Promise.all([
            import('../lib/sync/session'),
            import('../lib/platform/native-backup-files'),
          ]);
        controller.signal.throwIfAborted();
        const candidate = await PersistentSession.open({
          ...cloudConfiguration,
          useLocalRecovery,
          files: nativeBackupFiles,
          signal: controller.signal,
          beforeOpenCloudCache: isTauri()
            ? async () => {
                controller.signal.throwIfAborted();
                showOpening = true;
                explainKeychain = true;
                await tick();
              }
            : undefined,
        });
        if (controller.signal.aborted) {
          candidate.close();
          return;
        }
        session = candidate;
        repository = candidate.repository;
        auth = candidate.auth;
        sync = candidate.sync;
        ready = (workspace) => candidate.attachController(workspace);
      }
      phase = 'ready';
    } catch {
      if (!controller.signal.aborted) phase = 'failed';
    } finally {
      clearTimeout(noticeTimer);
      if (restoreFocus) {
        await tick();
        if (
          !newerFocus &&
          !controller.signal.aborted &&
          openingController === controller &&
          phase === 'failed'
        )
          (useLocalRecovery ? localRecoveryButton : retryButton)?.focus();
        document.removeEventListener('focusin', observeFocus);
      }
    }
  }
  onMount(() => {
    void open();
    return () => {
      openingController?.abort();
      session?.close();
    };
  });
</script>

{#if phase === 'ready' && repository}<Workspace
    {repository}
    {auth}
    {sync}
    {windowAdapter}
    appearance={appearance.preference}
    onappearancechange={appearance.setPreference}
    onready={ready}
  />{:else}<main
    class="startup-screen"
    aria-labelledby={phase === 'failed' || showOpening
      ? 'startup-title'
      : undefined}
  >
    <div role="status">
      {#if phase === 'opening' && showOpening}
        <h1 id="startup-title">Opening your notes…</h1>
        {#if explainKeychain}
          <p>
            If macOS asks for access to
            <strong>“Scratchtree WebCrypto Master Key,”</strong>
            respond in the macOS dialog. Scratchtree uses this key to keep you signed
            in. Your notes will open automatically once they’re ready.
          </p>
        {/if}
      {/if}
    </div>
    {#if phase === 'failed'}
      <div role="alert">
        <h1 id="startup-title">Couldn’t open your notes</h1>
        <p>Scratchtree kept your existing library in place.</p>
      </div>
      <button
        type="button"
        class="startup-retry"
        bind:this={retryButton}
        onclick={() => void open()}>Try again</button
      >
      <hr />
      <p>
        You can open a separate set of local notes. Scratchtree will remember
        this choice for future launches, and your existing library will stay in
        place.
      </p>
      <button
        type="button"
        class="startup-local"
        bind:this={localRecoveryButton}
        onclick={() => void open(true)}>Use separate local notes</button
      >
    {/if}
  </main>{/if}

<style>
  .startup-screen {
    display: block;
    max-width: 36rem;
    margin-inline: auto;
    padding: clamp(1.5rem, 10vh, 4rem) 1.5rem 1.5rem;
    overflow: auto;
    overflow-wrap: anywhere;
  }
  .startup-screen h1 {
    font-size: 1.25rem;
    margin-block-end: 0.375rem;
  }
  .startup-screen p {
    margin-block-end: 0.875rem;
  }
  .startup-screen hr {
    border: 0;
    border-block-start: 1px solid var(--divider);
    margin-block: 1.375rem;
  }
  .startup-screen button {
    max-inline-size: 100%;
    padding-inline: 0.875rem;
  }
  .startup-retry {
    background: var(--foreground);
    color: var(--canvas);
    border-color: transparent;
    font-weight: 600;
  }
  .startup-retry:hover:enabled {
    background: var(--secondary);
  }
  .startup-local {
    background: transparent;
    border-color: var(--muted);
  }
</style>
