<script lang="ts">
  import { tick, untrack } from 'svelte';
  import NativeKeychainNotice from './NativeKeychainNotice.svelte';
  import type { AuthPort, AuthState } from '../sync/service-types';
  let {
    auth,
    value,
    native = false,
  }: { auth: AuthPort; value: AuthState; native?: boolean } = $props();
  let email = $state(untrack(() => value.email));
  let code = $state('');
  let dialog: HTMLDialogElement;
  let emailInput: HTMLInputElement;
  let codeInput: HTMLInputElement;
  let verificationStatus = $state<HTMLElement>();
  let syncStatus = $state<HTMLElement>();
  let joinButton = $state<HTMLButtonElement>();
  let retryButton = $state<HTMLButtonElement>();
  let emailValid = $state(false);
  let submitting = false;
  let priorPhase = untrack(() => value.phase);
  function mount(node: HTMLDialogElement) {
    dialog = node;
    node.showModal();
    void tick().then(() => {
      emailValid = emailInput.validity.valid;
      focusCurrent();
    });
    return { destroy: () => node.close() };
  }
  function focusCurrent() {
    if (value.phase === 'syncing') {
      if (!value.canCancel) syncStatus?.focus();
      else if (value.join) joinButton?.focus();
      else if (value.error) retryButton?.focus();
      else syncStatus?.focus();
    } else if (value.phase === 'verifying') verificationStatus?.focus();
    else if (value.phase === 'code') codeInput?.focus();
    else if (value.phase === 'email') emailInput?.focus();
  }
  $effect(() => {
    const phase = value.phase;
    if (phase === 'code' && priorPhase !== 'code')
      void tick().then(() => codeInput?.focus());
    if (phase === 'verifying' && priorPhase !== 'verifying')
      void tick().then(() => verificationStatus?.focus());
    if (phase === 'email' && priorPhase !== 'email')
      void tick().then(() => {
        emailValid = emailInput.validity.valid;
        emailInput.focus();
      });
    priorPhase = phase;
  });
  $effect(() => {
    const phase = value.phase;
    const canCancel = value.canCancel;
    const join = value.join;
    const error = value.error;
    if (phase === 'syncing') {
      void tick().then(() => {
        if (
          value.phase === phase &&
          value.canCancel === canCancel &&
          value.join === join &&
          value.error === error &&
          (dialog?.contains(document.activeElement) ||
            document.activeElement === document.body)
        )
          focusCurrent();
      });
    }
  });
  function dismiss() {
    if (value.canCancel) auth.dismiss();
  }
  function keydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'input:not(:disabled),button:not(:disabled)',
      ),
    );
    if (!controls.length) {
      event.preventDefault();
      return;
    }
    const i = controls.indexOf(document.activeElement as HTMLElement);
    if (
      i < 0 ||
      (event.shiftKey && i === 0) ||
      (!event.shiftKey && i === controls.length - 1)
    ) {
      event.preventDefault();
      controls[event.shiftKey ? controls.length - 1 : 0].focus();
    }
  }
  async function submit() {
    if (submitting) return;
    submitting = true;
    try {
      if (value.phase === 'email' && emailValid) {
        code = '';
        await auth.submitEmail(email.trim());
      } else if (value.phase === 'code' && code.trim())
        await auth.submitCode(code);
    } finally {
      submitting = false;
    }
  }
</script>

<dialog
  class="auth-dialog"
  use:mount
  aria-labelledby="auth-title"
  onkeydown={keydown}
  oncancel={(e) => {
    e.preventDefault();
    dismiss();
  }}
  onclick={(e) => {
    const rect = dialog.getBoundingClientRect();
    if (
      e.target === dialog &&
      (e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom)
    )
      dismiss();
  }}
>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <h2 id="auth-title">Sign in / sign up</h2>
    <p class="auth-instruction">
      Sign in with an existing account. Sign-up is coming soon.
    </p>
    {#if native}<NativeKeychainNotice id="auth-keychain-notice" />{/if}
    <label for="auth-email">Email</label>
    <input
      id="auth-email"
      bind:this={emailInput}
      type="email"
      required
      autocomplete="email"
      aria-describedby={native ? 'auth-keychain-notice' : undefined}
      bind:value={email}
      disabled={value.phase !== 'email'}
      oninput={(e) => (emailValid = e.currentTarget.validity.valid)}
    />
    <label for="auth-code">Code</label>
    {#if value.phase === 'email' || value.phase === 'sending-code'}<p
        class="auth-instruction"
      >
        Send a code to enable this field.
      </p>{/if}
    <input
      id="auth-code"
      bind:this={codeInput}
      autocomplete="one-time-code"
      bind:value={code}
      disabled={value.phase !== 'code'}
    />
    {#if value.error}<p role="alert">{value.error}</p>{/if}
    {#if value.phase === 'verifying'}<p
        role="status"
        tabindex="-1"
        bind:this={verificationStatus}
      >
        Finishing sign in. Please wait.
      </p>{/if}
    {#if value.phase === 'syncing' && (!value.join || !value.canCancel)}<p
        role="status"
        tabindex="-1"
        bind:this={syncStatus}
      >
        {value.join
          ? 'Applying synced notes. Please wait.'
          : 'Signed in. Initial sync is pending.'}
      </p>{/if}
    {#if value.phase === 'sending-code'}<p role="status">
        Preparing sign-in…
      </p>{/if}
    {#if value.join}
      <p>
        This Mac has {value.join.localNotes} notes. Synced notes: {value.join
          .cloudNotes}.
      </p>
      <p>This Mac’s notes will be kept in recovery.</p>
    {/if}
    <div class="auth-actions">
      {#if value.canCancel}<button type="button" onclick={dismiss}>Close</button
        >{/if}
      {#if value.join}
        <button
          type="button"
          bind:this={joinButton}
          disabled={!auth.acceptCloud || !value.canCancel}
          onclick={() => void auth.acceptCloud?.()}>Use synced notes</button
        >
      {:else if value.phase === 'syncing' && value.error}<button
          type="button"
          bind:this={retryButton}
          onclick={() => void auth.retrySync()}>Retry sync</button
        >
      {:else if value.phase === 'email' || value.phase === 'sending-code'}<button
          type="submit"
          disabled={value.phase !== 'email' || !emailValid}>Send code</button
        >
      {:else if value.phase === 'code' || value.phase === 'verifying'}
        {#if value.phase === 'code' && auth.restartSignIn}<button
            type="button"
            onclick={() => auth.restartSignIn?.()}>Start over</button
          >{/if}
        <button type="submit" disabled={value.phase !== 'code' || !code.trim()}
          >Sign in</button
        >{/if}
    </div>
  </form>
</dialog>
