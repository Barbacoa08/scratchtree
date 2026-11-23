<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type {
    DesktopUpdateOffer,
    DesktopUpdatePort,
  } from '../platform/desktop-updates';
  import Icon from './Icon.svelte';

  let {
    port,
    blocked,
    beforeInstall,
    onmodalchange,
  }: {
    port: DesktopUpdatePort;
    blocked: boolean;
    beforeInstall: () => Promise<'ready' | 'blocked' | 'save-failed'>;
    onmodalchange: (open: boolean) => void;
  } = $props();

  const archCommand = 'sudo pacman -Syu scratchtree-preview';
  let offer = $state<DesktopUpdateOffer | null>(null);
  let reviewing = $state(false);
  let phase = $state<
    'idle' | 'saving' | 'installing' | 'restarting' | 'copying'
  >('idle');
  let error = $state('');
  let stopped = $state<{ action: 'recover' | 'reopen'; message: string }>();
  let copied = $state(false);
  let trigger = $state<HTMLButtonElement>();
  let later = $state<HTMLButtonElement>();
  let confirm = $state<HTMLButtonElement>();
  let disposed = false;

  onMount(() => {
    void port
      .check()
      .then((candidate) => {
        if (!disposed) offer = candidate;
      })
      .catch(() => {
        // Discovery is optional. An unavailable feed must leave notes usable.
      });
    return () => {
      disposed = true;
      if (reviewing) onmodalchange(false);
    };
  });

  function review() {
    if (!offer || blocked || reviewing) return;
    error = stopped?.message ?? '';
    copied = false;
    onmodalchange(true);
    reviewing = true;
  }

  function show(node: HTMLDialogElement) {
    node.showModal();
    later?.focus();
    return { destroy: () => node.close() };
  }

  async function dismiss() {
    if (phase !== 'idle' || !reviewing) return;
    reviewing = false;
    onmodalchange(false);
    await tick();
    if (document.activeElement === document.body) trigger?.focus();
  }

  async function update() {
    const selected = offer;
    if (
      selected?.platform !== 'mac' ||
      phase !== 'idle' ||
      !reviewing ||
      stopped
    )
      return;
    error = '';
    phase = 'saving';
    try {
      const readiness = await beforeInstall();
      if (disposed) return;
      if (readiness === 'blocked') {
        error = 'Finish the current operation or recovery, then try again.';
        return;
      }
      if (readiness === 'save-failed') {
        error = 'Could not save your changes. Try again before updating.';
        return;
      }
      phase = 'installing';
      await port.install(selected.version);
      if (!disposed) phase = 'restarting';
    } catch (failure) {
      if (disposed) return;
      if (
        phase === 'installing' &&
        typeof failure === 'object' &&
        failure !== null &&
        'code' in failure &&
        (failure.code === 'update_manual_recovery' ||
          failure.code === 'update_bundle_changed')
      ) {
        const restoreFocus = document.activeElement === confirm;
        const action =
          failure.code === 'update_bundle_changed' ? 'reopen' : 'recover';
        const fallback =
          action === 'reopen'
            ? 'Reopen Scratchtree before checking for updates.'
            : 'Use the manual DMG to reinstall Scratchtree.';
        stopped = {
          action,
          message:
            'message' in failure && typeof failure.message === 'string'
              ? failure.message
              : fallback,
        };
        error = stopped.message;
        if (restoreFocus) {
          await tick();
          if (
            !disposed &&
            reviewing &&
            document.activeElement === document.body
          )
            later?.focus();
        }
      } else {
        error =
          phase === 'saving'
            ? 'Could not save your changes. Try again before updating.'
            : 'Could not install the update. Try again or choose Later to keep working.';
      }
    } finally {
      if (!disposed && phase !== 'restarting') phase = 'idle';
    }
  }

  async function copyCommand() {
    if (offer?.platform !== 'arch' || phase !== 'idle' || !reviewing) return;
    phase = 'copying';
    error = '';
    copied = false;
    try {
      await port.copyCommand(archCommand);
      if (!disposed) copied = true;
    } catch {
      if (!disposed)
        error = 'Could not copy the command. Select and copy it from above.';
    } finally {
      if (!disposed) phase = 'idle';
    }
  }
</script>

<div class="sr-only" role="status">
  {offer && !stopped
    ? `Scratchtree version ${offer.version} is available.`
    : ''}
</div>
{#if offer}
  <section class="desktop-update" aria-label="Scratchtree update">
    <p class="update-label">
      <Icon name="update" /><strong
        >{stopped?.action === 'recover'
          ? 'Update needs recovery'
          : stopped?.action === 'reopen'
            ? 'Restart needed'
            : 'Update available'}</strong
      >
    </p>
    {#if !stopped}<p class="update-version">Version {offer.version}</p>{/if}
    <button
      type="button"
      class="update-trigger"
      bind:this={trigger}
      disabled={blocked}
      onclick={review}
      >{stopped?.action === 'recover'
        ? 'Recovery instructions'
        : stopped?.action === 'reopen'
          ? 'Update status'
          : offer.platform === 'mac'
            ? 'Update now'
            : 'View update'}</button
    >
  </section>
  {#if reviewing}
    <dialog
      class="desktop-update-dialog"
      aria-labelledby="desktop-update-title"
      use:show
      oncancel={(event) => {
        event.preventDefault();
        void dismiss();
      }}
    >
      <h2 id="desktop-update-title">
        {stopped?.action === 'recover'
          ? 'Scratchtree update recovery'
          : stopped?.action === 'reopen'
            ? 'Reopen Scratchtree'
            : `Update to Scratchtree ${offer.version}`}
      </h2>
      {#if !stopped && offer.platform === 'mac'}
        <p>
          Scratchtree will save your notes and drafts before installing the
          update and reopening.
        </p>
      {:else if offer.platform === 'arch'}
        <p>
          With the Scratchtree package repository configured, save your work and
          close Scratchtree. Run this command in Terminal to update Scratchtree
          and your system.
        </p>
        <pre><code>{archCommand}</code></pre>
      {/if}
      {#if offer.notes && !stopped}
        <details>
          <summary>What’s new</summary>
          <p class="update-notes">{offer.notes}</p>
        </details>
      {/if}
      {#if error}<p role="alert">{error}</p>{/if}
      <div role="status">
        {#if phase === 'saving'}Saving notes and drafts…
        {:else if phase === 'installing'}Downloading and installing the update…
        {:else if phase === 'restarting'}Restarting Scratchtree…
        {:else if copied}Update command copied.{/if}
      </div>
      <div class="update-actions">
        <button
          type="button"
          bind:this={later}
          aria-disabled={phase !== 'idle'}
          onclick={() => void dismiss()}>{stopped ? 'Close' : 'Later'}</button
        >
        {#if offer.platform === 'mac' && !stopped}
          <button
            type="button"
            class="update-trigger"
            aria-disabled={phase !== 'idle'}
            bind:this={confirm}
            onclick={() => void update()}
            >{error ? 'Retry update' : 'Update and restart'}</button
          >
        {:else if offer.platform === 'arch'}
          <button
            type="button"
            class="update-trigger"
            aria-disabled={phase !== 'idle'}
            onclick={() => void copyCommand()}>Copy update command</button
          >
        {/if}
      </div>
    </dialog>
  {/if}
{/if}

<style>
  .desktop-update {
    border-top: 1px solid var(--root-divider);
    margin-top: 0.75rem;
    padding: 0.75rem min(calc(24px + 2px), 12%) 0;
  }
  .update-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
  }
  .update-label :global(.icon) {
    color: var(--focus);
    width: 1rem;
    height: 1rem;
    flex: 0 0 1rem;
  }
  .update-version {
    margin: 0.18rem 0 0.55rem 1.4rem;
    color: var(--secondary);
    font-size: 0.75rem;
  }
  .desktop-update .update-trigger {
    display: block;
    width: 100%;
    text-align: center;
  }
  .desktop-update .update-trigger {
    padding-inline: 0.55rem;
    color: var(--nav-text);
    background: var(--nav-background);
    border-color: var(--nav-border);
  }
  .desktop-update .update-trigger:hover:enabled {
    color: var(--nav-text);
    border-color: var(--focus);
  }
  .desktop-update-dialog {
    width: min(28rem, calc(100vw - 2rem));
    max-height: calc(100% - 2rem);
    color: var(--foreground);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.5rem;
  }
  .desktop-update-dialog::backdrop {
    background: rgb(0 0 0 / 55%);
  }
  .desktop-update-dialog h2 {
    margin-top: 0;
    color: var(--heading);
    text-transform: none;
    letter-spacing: normal;
    overflow-wrap: anywhere;
  }
  .desktop-update-dialog pre,
  .update-notes {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .update-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: end;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .update-actions button {
    color: var(--foreground);
    background: var(--control);
    border-color: var(--border);
    padding: 0.4rem 0.55rem;
  }
  .update-actions button:hover:not([aria-disabled='true']) {
    background: var(--control-hover);
  }
  .update-actions .update-trigger {
    color: var(--nav-text);
    background: var(--nav-background);
    border-color: var(--nav-border);
  }
  .update-actions .update-trigger:hover:not([aria-disabled='true']) {
    background: var(--nav-background);
    border-color: var(--focus);
  }
  .update-actions [aria-disabled='true'] {
    opacity: 0.6;
    cursor: default;
  }
</style>
