<script lang="ts">
  import { onMount } from 'svelte';
  import { renderMarkdownBlocks, externalUrl } from '../domain/markdown';
  let {
    source,
    onopen,
    oncopycode,
  }: {
    source: string;
    onopen: (url: string) => void;
    oncopycode: (code: string) => void;
  } = $props();
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
          oncopycode(code);
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
