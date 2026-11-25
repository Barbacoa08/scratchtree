<script lang="ts">
  import Icon from './Icon.svelte';
  import type { MoveConfirmation } from '../workspace/controller';

  let {
    move,
    hidden,
    canOpen,
    onopen,
    onexpire,
  }: {
    move: MoveConfirmation;
    hidden: boolean;
    canOpen: boolean;
    onopen: () => void;
    onexpire: () => void;
  } = $props();

  let hovered = $state(false);
  let focused = $state(false);
  let remaining = 5000;

  $effect(() => {
    if (hidden) {
      hovered = false;
      focused = false;
      return;
    }
    if (hovered || focused) return;
    const started = performance.now();
    const timer = setTimeout(onexpire, remaining);
    return () => {
      clearTimeout(timer);
      remaining = Math.max(0, remaining - (performance.now() - started));
    };
  });
</script>

<section
  class="move-toast"
  aria-label="Move confirmation"
  {hidden}
  onpointerenter={() => (hovered = true)}
  onpointerleave={() => (hovered = false)}
  onfocusin={() => (focused = true)}
  onfocusout={(event) => {
    focused =
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget);
  }}
>
  <div class="move-toast-check"><Icon name="check" /></div>
  <p>
    {move.summary} <strong>{move.path}.</strong>
  </p>
  <button
    type="button"
    aria-disabled={!canOpen}
    onclick={() => {
      if (canOpen) onopen();
    }}
  >
    Go to tree <Icon name="chevron" />
  </button>
</section>
