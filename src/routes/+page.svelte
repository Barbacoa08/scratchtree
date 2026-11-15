<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core';
  import NativeKeychainNotice from '../lib/components/NativeKeychainNotice.svelte';
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
  let mounted = $state(false);
  let opening = $state(false);
  let openingError = $state(false);
  let openingRetry = $state<HTMLButtonElement>();
  let slowOpening = $state(false);
  let permissionWait = $state(false);
  let native = $state(false);
  let pendingOpen:
    { controller: AbortController; promise: Promise<void> } | undefined;
  let alive = false;
  let session: PersistentSession | undefined;

  async function open() {
    if (opening) return;
    const restoreRetry = document.activeElement === openingRetry;
    let newerFocus = false;
    function observeFocus(event: FocusEvent) {
      if (
        event.target instanceof Element &&
        event.target !== openingRetry &&
        event.target !== document.body &&
        event.target !== document.documentElement
      )
        newerFocus = true;
    }
    if (restoreRetry) document.addEventListener('focusin', observeFocus);
    opening = true;
    const noticeTimer = setTimeout(() => {
      if (alive && !mounted) slowOpening = true;
    }, 500);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const parameters = new URL(location.href).searchParams;
      if (import.meta.env.DEV && parameters.has('fixture')) {
        const fixture = await import('../../tests/fixtures/browser');
        repository = fixture.repository;
        ready = fixture.ready;
        if (parameters.has('lifecycle')) windowAdapter = fixture.windowAdapter;
        if (parameters.has('authFixture')) {
          const authFixture = await import('../../tests/fixtures/auth-ui');
          auth = authFixture.auth;
          sync = authFixture.sync;
          authFixture.install();
        }
      } else {
        // A caller deadline stops only this wait. The captured startup keeps its
        // ownership until it settles or unmount aborts it; Retry reuses it.
        if (!pendingOpen) {
          const controller = new AbortController();
          const promise = (async () => {
            const [{ PersistentSession }, { nativeBackupFiles }] =
              await Promise.all([
                import('../lib/sync/session'),
                import('../lib/platform/native-backup-files'),
              ]);
            if (controller.signal.aborted) return;
            const candidate = await PersistentSession.open({
              ...cloudConfiguration,
              files: nativeBackupFiles,
              signal: controller.signal,
              beforeOpenCloudCache: native
                ? async () => {
                    if (!alive || controller.signal.aborted) return;
                    slowOpening = true;
                    await tick();
                  }
                : undefined,
            });
            if (!alive || controller.signal.aborted) {
              candidate.close();
              return;
            }
            session = candidate;
            repository = candidate.repository;
            auth = candidate.auth;
            sync = candidate.sync;
            ready = (workspace) => candidate.attachController(workspace);
            openingError = false;
            mounted = true;
          })();
          const attempt = { controller, promise };
          pendingOpen = attempt;
          // Only actual settlement permits another startup. A soft deadline is
          // not cancellation of the SDK's already-entered readiness work.
          void promise.then(
            () => {
              if (pendingOpen === attempt) pendingOpen = undefined;
            },
            () => {
              if (pendingOpen !== attempt) return;
              pendingOpen = undefined;
              if (alive) {
                permissionWait = false;
                openingError = true;
              }
            },
          );
        }
        await Promise.race([
          pendingOpen.promise,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              permissionWait = true;
              reject(new Error('Notes are still opening.'));
            }, 10000);
          }),
        ]);
      }
      if (alive) mounted = true;
    } catch {
      if (alive) {
        permissionWait = !!pendingOpen;
        openingError = true;
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(noticeTimer);
      opening = false;
      await tick();
      if (restoreRetry && !newerFocus && alive && !mounted && openingError)
        openingRetry?.focus();
      document.removeEventListener('focusin', observeFocus);
    }
  }
  onMount(() => {
    alive = true;
    native = isTauri();
    void open();
    return () => {
      alive = false;
      pendingOpen?.controller.abort();
      session?.close();
    };
  });
</script>

{#if mounted && repository}<Workspace
    {repository}
    {auth}
    {sync}
    {windowAdapter}
    appearance={appearance.preference}
    onappearancechange={appearance.setPreference}
    onready={ready}
  />{:else if openingError}<main
    class="startup-error"
    aria-labelledby="startup-title"
  >
    <h1 id="startup-title">
      {permissionWait ? 'Notes are still opening' : 'Could not open your notes'}
    </h1>
    <p role="status">{opening ? 'Opening your notes…' : ''}</p>
    {#if !opening}<p role="alert">
        {permissionWait
          ? 'Opening is taking longer than expected. Complete any system permission prompt, then retry. Your notes have not been replaced.'
          : 'Scratchtree could not open the notes stored on this Mac. Your existing library has not been replaced.'}
      </p>{/if}
    {#if native}<NativeKeychainNotice />{/if}
    <button
      bind:this={openingRetry}
      disabled={opening}
      onclick={() => void open()}>Retry opening notes</button
    >
  </main>{:else if opening && slowOpening}<section
    class="startup-error"
    aria-label="Opening notes"
  >
    <p role="status">Opening your notes…</p>
    {#if native}<NativeKeychainNotice />{/if}
  </section>{/if}

<style>
  .startup-error {
    max-width: 36rem;
    margin: 4rem auto;
    padding: 1.5rem;
  }
</style>
