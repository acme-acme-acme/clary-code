import type { CodePosition } from "./codeIntelligenceEdits";

export function fileShadow(root: HTMLElement) {
  return root.querySelector("diffs-container")?.shadowRoot ?? null;
}

function textPoint(element: Element, character: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let remaining = character;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return { node: element, offset: element.childNodes.length };
}

/** Map one-based columns through Pierre's highlighted spans without modifying their DOM. */
export function lineTextRange(
  first: Element,
  startColumn: number,
  last = first,
  endColumn = startColumn,
) {
  const from = textPoint(first, startColumn - 1);
  const to = textPoint(last, endColumn - 1);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

export function fileDomRange(root: HTMLElement, start: CodePosition, end = start) {
  const shadow = fileShadow(root);
  const first = shadow?.querySelector(`[data-content] [data-line="${start.line}"]`);
  const last = shadow?.querySelector(`[data-content] [data-line="${end.line}"]`);
  if (!first || !last) return;
  return lineTextRange(first, start.column, last, end.column);
}

/** The code line element and one-based column under a viewport point inside a Pierre shadow root. */
export function codeLineAtPoint(shadow: ShadowRoot, x: number, y: number) {
  const caret = document.caretPositionFromPoint?.(x, y, { shadowRoots: [shadow] });
  const fallback = caret ? null : document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (!node || offset === undefined || !shadow.contains(node)) return;
  const element = node instanceof Element ? node : node.parentElement;
  const line = element?.closest<HTMLElement>("[data-line]");
  if (!line?.closest("[data-content]")) return;
  const prefix = document.createRange();
  prefix.setStart(line, 0);
  prefix.setEnd(node, offset);
  return { element: line, column: prefix.toString().length + 1 };
}

export function filePositionAtPoint(
  root: HTMLElement,
  x: number,
  y: number,
): CodePosition | undefined {
  const shadow = fileShadow(root);
  const hit = shadow ? codeLineAtPoint(shadow, x, y) : undefined;
  return hit ? { line: Number(hit.element.dataset.line), column: hit.column } : undefined;
}

export type PopupAnchor = { left: number; top?: number; bottom?: number };

/**
 * Places a popup below `rect`, or above it for hovers (as VS Code does) when `height` fits.
 * An above-popup anchors its bottom edge, so it touches its word however tall it renders.
 */
export function popupPosition(rect: DOMRect, height = 220, above = false): PopupAnchor {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 400));
  const fitsBelow = rect.bottom + height < window.innerHeight;
  const fitsAbove = rect.top - height > 8;
  return (above ? fitsAbove : !fitsBelow && fitsAbove)
    ? { left, bottom: window.innerHeight - rect.top + 4 }
    : { left, top: fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - height - 4) };
}
