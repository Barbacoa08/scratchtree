<script module lang="ts">
  import type { Item } from '../domain/notes';
  export type PendingNote = Pick<Item, 'id' | 'markdown'> & { pending: true };
</script>

<script lang="ts">
  import type { EditorState } from '@codemirror/state';
  import { itemLabel } from '../domain/hierarchy';
  import TreeIcon from './TreeIcon.svelte';
  import { markerColors } from '../workspace/colors';
  import { timestampPresentation } from '../domain/timestamps';
  import NoteBody from './NoteBody.svelte';
  import { copyIcon } from '../copy-icon';
  let {
    item,
    commandLabel,
    selected,
    primary,
    permanent,
    editing,
    source,
    baseline,
    states,
    readOnly,
    disabled,
    expanded,
    outsideSearch,
    location,
    onselect,
    ondoubleclick,
    onselectbutton,
    onhandleselect,
    onselectionpointer,
    onedit,
    ondelete,
    oncopy,
    ondone,
    onsource,
    onsubmit,
    onfinish,
    onblur,
    onfocus,
    oncontext,
    onopen,
    oncopycode,
    onexpand,
    reorderable,
    reorderDisabled,
    dragDisabled,
    selectionDisabled,
    dropEdge,
    ondragstart,
    ondragend,
    ondragover,
    ondragleave,
    ondrop,
    onmovekey,
  }: {
    item: Item | PendingNote;
    commandLabel: string;
    selected: boolean;
    primary: boolean;
    permanent: boolean;
    editing: boolean;
    source: string;
    baseline?: number;
    states: Map<string, EditorState>;
    readOnly: boolean;
    disabled: boolean;
    expanded: boolean;
    outsideSearch: boolean;
    location: string;
    onselect: (event: MouseEvent) => void;
    ondoubleclick: (event: MouseEvent) => void;
    onselectbutton: (event: MouseEvent) => void;
    onhandleselect: (event: MouseEvent) => void;
    onselectionpointer: (event: PointerEvent) => void;
    onedit: () => void;
    ondelete: () => void;
    oncopy: () => void;
    ondone: () => void;
    onsource: (source: string) => void;
    onsubmit: () => void;
    onfinish: () => void;
    onblur: () => void;
    onfocus: () => void;
    oncontext: (fenced: boolean) => void;
    onopen: (url: string) => void;
    oncopycode: (code: string) => void;
    onexpand: (expanded: boolean) => void;
    reorderable: boolean;
    reorderDisabled: boolean;
    dragDisabled: boolean;
    selectionDisabled: boolean;
    dropEdge: 'before' | 'after' | null;
    ondragstart: (event: DragEvent) => void;
    ondragend: () => void;
    ondragover: (event: DragEvent) => void;
    ondragleave: (event: DragEvent) => void;
    ondrop: (event: DragEvent) => void;
    onmovekey: (event: KeyboardEvent) => void;
  } = $props();
  let body = $state<NoteBody>();
  let lineCenter = $state<number>();
  let multiline = $state(false);
  let markerBottom = $state(0);
  let saved = $derived('pending' in item ? null : item);
  let kind = $derived(saved?.kind ?? 'note');
  export function toggleExpanded() {
    return body?.toggleExpanded() ?? false;
  }
  export function focus(options?: { end?: boolean }) {
    body?.focus(options);
  }
</script>

<!-- Selection and actions are separate from rendered content and links. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
  aria-hidden={saved ? undefined : true}
  aria-label={saved?.kind === 'tree'
    ? `Tree ${itemLabel(saved)}`
    : saved
      ? 'Saved note'
      : undefined}
  class:selected={saved && selected}
  class="note-card"
  class:pending-capture={!saved}
  class:editing
  class:drop-before={dropEdge === 'before'}
  class:drop-after={dropEdge === 'after'}
  ondragover={saved ? ondragover : undefined}
  ondragleave={saved ? ondragleave : undefined}
  ondrop={saved ? ondrop : undefined}
  class:done={saved?.done}
  data-note-id={saved?.id}
  style:--selection-color={saved?.color ? markerColors[saved.color] : undefined}
  style:--item-line-center={lineCenter === undefined
    ? undefined
    : `${lineCenter}px`}
  data-kind={kind}
  data-colored={!!saved?.color}
  data-entry-id={saved?.id}
  data-pending-capture={saved ? undefined : item.id}
  onclick={saved ? onselect : undefined}
  onpointerdown={saved ? onselectionpointer : undefined}
  ondblclick={saved ? ondoubleclick : undefined}
>
  {#if saved?.color}<span
      class="note-color"
      class:multiline
      style:--item-color-bottom={`${markerBottom}px`}
      aria-hidden="true"
    ></span>{/if}
  {#if saved}<div class="item-slot">
      <button
        class="note-select"
        aria-pressed={selected}
        disabled={selectionDisabled}
        onclick={onselectbutton}
        aria-label={kind === 'tree' ? 'Select tree' : 'Select note'}
        title={kind === 'tree' ? 'Select tree' : 'Select note'}
      >
        {#if kind === 'tree'}<TreeIcon />{/if}
      </button>
      {#if reorderable}<button
          class="drag-handle"
          draggable={!dragDisabled}
          disabled={reorderDisabled}
          aria-label="Reorder note"
          title={reorderDisabled
            ? undefined
            : dragDisabled
              ? `${commandLabel} Up/Down to reorder`
              : `Drag to reorder · ${commandLabel} Up/Down`}
          onclick={onhandleselect}
          {ondragstart}
          {ondragend}
          onkeydown={onmovekey}
        >
          <span aria-hidden="true">
            <svg class="drag-icon">
              <svg
                class="grip-drawing"
                viewBox="0 0 16 16"
                width="100%"
                height="100%"
                x={saved.color ? 1 : 0}
              >
                <path
                  d="M5 3h.01M11 3h.01M5 8h.01M11 8h.01M5 13h.01M11 13h.01"
                />
              </svg>
            </svg>
          </span>
        </button>{/if}
    </div>{/if}
  {#if saved?.done}<span class="sr-only">Done</span>{/if}
  <div class="note-meta">
    {#if saved}
      {@const updated = timestampPresentation(saved.updatedAt)}
      <time datetime={updated.datetime}>{updated.label}</time>
      {#if primary && !editing}<div class="card-actions">
          {#if !editing}<button
              {disabled}
              onclick={onedit}
              aria-label={kind === 'tree' ? 'Edit tree' : 'Edit note'}
              title={kind === 'tree' ? 'Edit tree' : 'Edit note'}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"
                ><path d="m3 10 7-7 3 3-7 7-4 1zM9 4l3 3" /></svg
              >
            </button>{/if}
          <button
            {disabled}
            onclick={() => ondone()}
            aria-label="Mark done"
            title={saved.done ? 'Mark not done (X)' : 'Mark done (X)'}
            aria-pressed={saved.done}
            ><svg viewBox="0 0 16 16" aria-hidden="true"
              ><path d="M3 3h10v10H3z" />{#if saved.done}<path
                  d="m5 8 2 2 4-4"
                />{/if}</svg
            ></button
          >
          <button
            {disabled}
            onclick={oncopy}
            aria-label="Copy Markdown"
            title="Copy Markdown"
          >
            {@html copyIcon}
          </button>
          <button
            {disabled}
            onclick={ondelete}
            aria-label={permanent
              ? kind === 'tree'
                ? 'Permanently delete tree'
                : 'Permanently delete note'
              : kind === 'tree'
                ? 'Delete tree'
                : 'Delete note'}
            title={permanent
              ? 'Permanently delete this note and its children'
              : kind === 'tree'
                ? 'Delete tree'
                : 'Delete note'}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"
              ><path d="M3 4h10M6 4V2h4v2M4 4l1 10h6l1-10M7 6v6M9 6v6" /></svg
            >
          </button>
        </div>{/if}
    {:else}
      <span>Saving note…</span>
    {/if}
  </div>
  {#if location}<p class="note-location">{location}</p>{/if}
  {#if outsideSearch}<p class="editing-outside">
      Editing outside search results
    </p>{/if}
  <NoteBody
    bind:this={body}
    onfirstline={(center) => (lineCenter = center)}
    onmarkerlayout={saved?.color
      ? (value, bottom) => {
          multiline = value;
          markerBottom = bottom;
        }
      : undefined}
    {expanded}
    {onexpand}
    id={item.id}
    markdown={item.markdown}
    {source}
    {editing}
    pending={!saved}
    {baseline}
    {states}
    {readOnly}
    onchange={onsource}
    {onsubmit}
    oncancel={onfinish}
    {onblur}
    {onfocus}
    {oncontext}
    {onopen}
    {oncopycode}
  />
</article>
