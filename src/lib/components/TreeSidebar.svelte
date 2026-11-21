<script lang="ts">
  import { untrack } from 'svelte';
  import { itemLabel, type HierarchyPresentation } from '../domain/hierarchy';
  import Icon from './Icon.svelte';
  import TreeIcon from './TreeIcon.svelte';
  import RootIcon from './RootIcon.svelte';
  let {
    presentation,
    showCommandHints = false,
    commandPrefix = '⌘',
    currentId,
    live = true,
    disabled,
    onopen,
  }: {
    presentation: HierarchyPresentation;
    showCommandHints?: boolean;
    commandPrefix?: string;
    currentId: string | null;
    live?: boolean;
    disabled: boolean;
    onopen: (id: string | null) => void;
  } = $props();
  let expanded = $state(new Set<string>());
  $effect(() => {
    const next = new Set(untrack(() => expanded));
    for (const tree of presentation.path(live ? currentId : null))
      next.add(tree.id);
    expanded = next;
  });
  let shortcuts = $derived(
    presentation
      .rows(new Set())
      .slice(0, 8)
      .map((row) => row.tree.id),
  );
  let rows = $derived(presentation.rows(expanded));
</script>

<nav aria-label="Trees" class="tree-navigation">
  <button
    class="root-link"
    class:current={live && currentId === null}
    aria-current={live && currentId === null ? 'page' : undefined}
    onclick={() => onopen(null)}
    {disabled}><RootIcon /> Root</button
  >
  <hr class="root-separator" />
  {#each rows as row (row.tree.id)}
    <div
      class="tree-row navigation-hint-anchor"
      class:current={currentId === row.tree.id}
      style:padding-left={`${Math.min(row.depth, 2) * 8}px`}
    >
      {#if row.hasChildren}<button
          class="tree-expand"
          aria-label={`${expanded.has(row.tree.id) ? 'Collapse' : 'Expand'} tree ${itemLabel(row.tree)}`}
          aria-expanded={expanded.has(row.tree.id)}
          {disabled}
          onclick={() => {
            const next = new Set(expanded);
            if (next.has(row.tree.id)) next.delete(row.tree.id);
            else next.add(row.tree.id);
            expanded = next;
          }}
          ><span class:expanded={expanded.has(row.tree.id)}
            ><Icon name="chevron" /></span
          ></button
        >{:else}<span class="tree-expand-spacer" aria-hidden="true"></span>{/if}
      <button
        class="tree-link"
        aria-current={currentId === row.tree.id ? 'page' : undefined}
        aria-label={`Open tree ${itemLabel(row.tree)}`}
        title={itemLabel(row.tree)}
        {disabled}
        onclick={() => onopen(row.tree.id)}
        ><TreeIcon color={row.tree.color} /><span class="tree-name"
          >{itemLabel(row.tree)}</span
        >{#if row.depth >= 3}<span class="tree-level"
            >Level {row.depth + 1}</span
          >{/if}</button
      >
      {#if showCommandHints && shortcuts.includes(row.tree.id)}<span
          class="command-hint tree-command-hint"
          aria-hidden="true"
          >{commandPrefix}{shortcuts.indexOf(row.tree.id) + 2}</span
        >{/if}
    </div>
  {/each}
</nav>
