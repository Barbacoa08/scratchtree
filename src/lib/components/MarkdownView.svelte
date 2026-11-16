<script lang="ts">
  import { onMount } from 'svelte';
  import { copyMarkdown } from '../platform/actions';
  import { renderMarkdownBlocks, externalUrl } from '../domain/markdown';
  let { source, onopen }: { source: string; onopen: (url: string) => void } =
    $props();
  let copyStatus = $state('');
  let host: HTMLDivElement;
  const rendered = $derived(renderMarkdownBlocks(source));
  onMount(() => {
    function activate(event: MouseEvent) {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        '.code-copy',
      );
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'click') {
          const code =
            rendered.code[Number(button.getAttribute('data-code-index'))];
          if (code === undefined) return;
          void copyMarkdown(code).then(
            () => {
              copyStatus = 'Code copied';
            },
            () => {
              copyStatus =
                'Copy failed. Your code is unchanged; retry Copy code.';
            },
          );
        }
        return;
      }
      const anchor = (event.target as Element).closest('a');
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const url = externalUrl(anchor.getAttribute('data-external-url') ?? '');
      if (url && event.type === 'click') onopen(url);
    }
    host.addEventListener('click', activate);
    host.addEventListener('auxclick', activate);
    return () => {
      host.removeEventListener('click', activate);
      host.removeEventListener('auxclick', activate);
    };
  });
</script>

<div class="markdown-view" bind:this={host}>{@html rendered.html}</div>

<p class="code-copy-feedback" aria-live="polite">{copyStatus}</p>
