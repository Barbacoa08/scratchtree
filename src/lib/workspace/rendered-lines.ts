/** Count rendered text rows, ignoring paragraph spacing and code-copy controls. */
export function exceedsPreviewLines(content: HTMLElement, limit = 5): boolean {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let count = 0;
  let bottom = -Infinity;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest('button,.sr-only') ||
      !node.textContent?.trim()
    ) {
      // A blank code row still occupies one visible line.
      if (!parent?.classList.contains('code-line') || node.textContent !== ' ')
        continue;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      if (rect.top >= bottom - 1) {
        if (++count > limit) return true;
        bottom = rect.bottom;
      } else bottom = Math.max(bottom, rect.bottom);
    }
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
      parent.closest('button,.sr-only,.code-copy-feedback') ||
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
