<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { EditorState } from '@codemirror/state';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import MarkdownView from './MarkdownView.svelte';
  import {
    countRenderedRows,
    firstPreviewLine,
    hasMultipleEditorRows,
  } from '../workspace/rendered-lines';
  import { firstLineCenter } from '../workspace/first-line';
  let {
    id,
    markdown,
    source,
    editing,
    pending,
    baseline,
    readOnly,
    states,
    onchange,
    onsubmit,
    oncancel,
    onblur,
    onfocus,
    onopen,
    oncopycode,
    oncontext,
    expanded,
    onexpand,
    onfirstline,
    onmarkerlayout,
  }: {
    expanded: boolean;
    onexpand: (expanded: boolean) => void;
    onfirstline: (center: number | undefined) => void;
    onmarkerlayout?: (multiline: boolean, bottom: number) => void;
    id: string;
    markdown: string;
    source: string;
    editing: boolean;
    pending: boolean;
    baseline?: number;
    readOnly: boolean;
    states: Map<string, EditorState>;
    onchange: (source: string) => void;
    onsubmit: () => void;
    oncancel: () => void;
    onblur: () => void;
    onfocus: () => void;
    onopen: (url: string) => void;
    oncopycode: (code: string) => void;
    oncontext: (fenced: boolean) => void;
  } = $props();
  let body: HTMLDivElement;
  let editor = $state<MarkdownEditor>();
  let rendered: HTMLDivElement | undefined = $state();
  let baselineMirror: HTMLDivElement | undefined = $state();
  let overflow = $state(false);
  let naturalHeight = $state(0);
  let cap = $state(384);
  let firstLineHeight = $state(20);
  let firstLineOffset = $state(0);
  let changed = $state(false);
  let entrySource = $state('');
  let wasEditing = false;
  let savedOverflow = false;
  let savedBaseline = $state(0);
  let activeCap = $derived(cap * (expanded ? 2 : 1));
  let height = $derived(
    editing
      ? Math.min(
          activeCap,
          changed ? Math.max(savedBaseline, naturalHeight) : savedBaseline,
        )
      : undefined,
  );
  // Change intent belongs to the edit session, never to the latest autosave snapshot.
  $effect.pre(() => {
    const active = editing;
    if (active && !wasEditing) {
      entrySource = untrack(() => source);
      savedBaseline = untrack(
        () => baseline ?? body?.getBoundingClientRect().height ?? 0,
      );
      savedOverflow = untrack(() => overflow);
      changed = false;
    }
    wasEditing = active;
  });
  $effect(() => {
    if (editing && source !== entrySource) changed = true;
  });
  function measure() {
    if (!body) return;
    const bodyRect = body.getBoundingClientRect();
    const content = editing
      ? body.querySelector<HTMLElement>('.cm-content')
      : rendered?.querySelector<HTMLElement>('.markdown-view');
    const editLine = editing ? content?.firstElementChild : null;
    // A virtualized editor may start with a gap, not the document's first line.
    // Keep the previous anchor until that first line is rendered again.
    if (!editing || editLine?.classList.contains('cm-line')) {
      const anchor = editing ? editLine : content;
      let center = anchor ? firstLineCenter(anchor) : null;
      if (center === null && editLine) {
        const rect = editLine.getBoundingClientRect();
        center = rect.top + rect.height / 2;
      }
      const editScroll = editing
        ? (body.querySelector('.cm-scroller')?.scrollTop ?? 0)
        : 0;
      onfirstline(
        center === null
          ? undefined
          : body.offsetTop +
              body.scrollTop +
              editScroll +
              center -
              bodyRect.top,
      );
    }
    const nextCap =
      parseFloat(getComputedStyle(body).getPropertyValue('--note-cap')) *
      parseFloat(getComputedStyle(document.documentElement).fontSize);
    cap = nextCap;
    const style = getComputedStyle(body);
    const lineHeight = parseFloat(style.lineHeight);
    if (!editing && rendered) {
      naturalHeight = rendered.getBoundingClientRect().height;
      const first = firstPreviewLine(rendered);
      firstLineHeight = first.height;
      firstLineOffset = first.offset;
      const rows = content ? countRenderedRows(content) : 0;
      overflow = rows > 5;
      if (!overflow && expanded) onexpand(false);
      // Match the text slice even before its collapse transform has settled.
      const previewTop = rendered.getBoundingClientRect().top + first.offset;
      const previewBottom = previewTop + first.height;
      for (const control of rendered.querySelectorAll<HTMLElement>(
        'a,button',
      )) {
        const rect = control.getBoundingClientRect();
        control.inert =
          overflow &&
          !expanded &&
          (rect.bottom <= previewTop || rect.top >= previewBottom);
      }
      onmarkerlayout?.(
        (!overflow || expanded) && rows > 1,
        body.offsetTop + bodyRect.height,
      );
    } else if (editing) {
      overflow = changed ? naturalHeight > lineHeight * 5 + 1 : savedOverflow;
      measureEditorMarker(content, bodyRect);
    }
  }
  function measureEditorMarker(
    content: HTMLElement | null | undefined,
    bodyRect: DOMRect,
  ) {
    onmarkerlayout?.(
      !!content && hasMultipleEditorRows(content, bodyRect),
      body.offsetTop + bodyRect.height,
    );
  }
  function onEditorScroll(event: Event) {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.classList.contains('cm-scroller')
    )
      measureEditorMarker(
        target.querySelector<HTMLElement>('.cm-content'),
        body.getBoundingClientRect(),
      );
  }
  $effect(() => {
    const node = rendered;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  });
  $effect(() => {
    markdown;
    source;
    naturalHeight;
    changed;
    editing;
    measure();
  });
  $effect(() => {
    const node = baselineMirror;
    if (!node) return;
    function resizeBaseline() {
      // This rendered-source mirror reacts to wrapping, text scaling, and late fonts.
      // It never uses the taller raw editor source as the entry footprint.
      const minimum = parseFloat(getComputedStyle(body).minHeight);
      const rendered = node!.querySelector<HTMLElement>('.markdown-view');
      savedOverflow = !!rendered && countRenderedRows(rendered) > 5;
      firstLineHeight = firstPreviewLine(node!).height;
      savedBaseline =
        savedOverflow && !expanded
          ? firstLineHeight
          : Math.max(minimum, node!.getBoundingClientRect().height);
      if (!changed) overflow = savedOverflow;
    }
    const observer = new ResizeObserver(resizeBaseline);
    observer.observe(node);
    resizeBaseline();
    return () => observer.disconnect();
  });
  onMount(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    observer.observe(document.documentElement);
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (!disposed) measure();
    });
    return () => {
      disposed = true;
      observer.disconnect();
    };
  });
  export function toggleExpanded() {
    if (!overflow || readOnly) return false;
    onexpand(!expanded);
    return true;
  }
  export function focus(options?: { end?: boolean }) {
    editor?.focus(options);
  }
  function grow(next: number) {
    if (naturalHeight !== next) naturalHeight = next;
  }
</script>

<div
  class="note-body"
  class:body-editing={editing}
  class:expanded
  class:preview-collapsed={!editing && overflow && !expanded}
  inert={pending}
  style:--preview-line={`${firstLineHeight}px`}
  style:--preview-offset={`${firstLineOffset}px`}
  bind:this={body}
  onscrollcapture={editing && onmarkerlayout ? onEditorScroll : undefined}
  style:height={height === undefined ? undefined : `${height}px`}
>
  {#if editing}
    <div
      class="note-baseline"
      bind:this={baselineMirror}
      aria-hidden="true"
      inert
    >
      <MarkdownView
        source={entrySource}
        onopen={() => {}}
        oncopycode={() => {}}
      />
    </div>
    <MarkdownEditor
      bind:this={editor}
      label="Edit Markdown"
      contextKey={id}
      {states}
      {source}
      {readOnly}
      {onchange}
      {onsubmit}
      {oncancel}
      {onblur}
      {onfocus}
      {oncontext}
      ongeometry={grow}
    />
  {:else}
    <div class="note-rendered" bind:this={rendered}>
      <MarkdownView source={markdown} {onopen} {oncopycode} />
    </div>
  {/if}
</div>
{#if overflow}
  <button
    class="note-expand"
    aria-label={expanded ? 'Collapse note' : 'Expand note'}
    aria-expanded={expanded}
    disabled={readOnly || pending}
    onmousedown={(event) => event.preventDefault()}
    onclick={toggleExpanded}
    >{expanded ? 'Collapse' : 'Expand'}<span
      class="note-expand-chevron"
      class:up={expanded}
      aria-hidden="true"
    ></span></button
  >
{/if}
