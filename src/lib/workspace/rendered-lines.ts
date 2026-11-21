/** Count up to the requested number of rendered rows, ignoring spacing and controls. */
export function countRenderedRows(
  content: HTMLElement,
  maxRows = 6,
  viewport?: Pick<DOMRect, 'top' | 'bottom'>,
): number {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let count = 0;
  let bottom = -Infinity;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest('button,.sr-only') ||
      (!viewport && !node.textContent?.trim())
    ) {
      // A blank code row still occupies one visible line.
      if (!parent?.classList.contains('code-line') || node.textContent !== ' ')
        continue;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      if (
        viewport &&
        (rect.bottom <= viewport.top + 1 || rect.top >= viewport.bottom - 1)
      )
        continue;
      if (rect.top >= bottom - 1) {
        if (++count >= maxRows) return count;
        bottom = rect.bottom;
      } else bottom = Math.max(bottom, rect.bottom);
    }
  }
  return count;
}

/** CodeMirror line boxes account for blank source rows as well as wrapped text. */
export function hasMultipleEditorRows(
  content: HTMLElement,
  viewport: DOMRect,
): boolean {
  let sawRow = false;
  for (const line of content.children) {
    if (!(line instanceof HTMLElement) || !line.classList.contains('cm-line'))
      continue;
    const rect = line.getBoundingClientRect();
    if (rect.top >= viewport.bottom - 1) break;
    if (rect.bottom <= viewport.top + 1) continue;
    if (sawRow || countRenderedRows(line, 2, viewport) > 1) return true;
    sawRow = true;
  }
  return false;
}

/** The first text line can follow block margins/padding that a one-line preview omits. */
export function firstPreviewLine(content: HTMLElement): {
  height: number;
  offset: number;
} {
  const fallback = parseFloat(getComputedStyle(content).lineHeight) || 20;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest('button,.sr-only') ||
      !node.textContent?.trim()
    )
      continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getClientRects()[0];
    if (!rect?.height) continue;
    const height = parseFloat(getComputedStyle(parent).lineHeight) || fallback;
    return {
      height,
      offset: Math.max(
        0,
        rect.top -
          content.getBoundingClientRect().top -
          (height - rect.height) / 2,
      ),
    };
  }
  return { height: fallback, offset: 0 };
}
