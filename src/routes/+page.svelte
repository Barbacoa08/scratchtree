<script lang="ts">
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
    let candidate: PersistentSession | undefined;
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
        const [{ PersistentSession }, { nativeBackupFiles }] =
          await Promise.all([
            import('../lib/sync/session'),
            import('../lib/platform/native-backup-files'),
          ]);
        candidate = await PersistentSession.open({
          ...cloudConfiguration,
          files: nativeBackupFiles,
        });
        if (!alive) {
          candidate.close();
          return;
        }
        session = candidate;
        repository = candidate.repository;
        auth = candidate.auth;
        sync = candidate.sync;
        const current = candidate;
        ready = (controller) => current.attachController(controller);
      }
      if (alive) mounted = true;
    } catch {
      candidate?.close();
      if (alive) openingError = true;
    } finally {
      opening = false;
      await tick();
      if (restoreRetry && !newerFocus && alive && !mounted && openingError)
        openingRetry?.focus();
      document.removeEventListener('focusin', observeFocus);
    }
  }
  onMount(() => {
    alive = true;
    void open();
    return () => {
      alive = false;
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
    <h1 id="startup-title">Could not open your notes</h1>
    <p role="status">{opening ? 'Opening your notes…' : ''}</p>
    {#if !opening}<p role="alert">
        Scratchtree could not open the notes stored on this Mac. Your existing
        library has not been replaced.
      </p>{/if}
    <button
      bind:this={openingRetry}
      disabled={opening}
      onclick={() => void open()}>Retry opening notes</button
    >
  </main>{/if}

<style>
  .startup-error {
    max-width: 36rem;
    margin: 4rem auto;
    padding: 1.5rem;
  }
</style>
