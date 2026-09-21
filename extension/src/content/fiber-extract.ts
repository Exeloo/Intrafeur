// Pulls the underlying row data (email/firstname/lastname) that Mantine
// React Table holds in React state, straight off the DOM node. This is a
// defensive fallback only: the current page renders the email as plain text
// (see attendance.ts), but this covers a future redesign that removes that.
//
// React attaches an internal fiber to each DOM node under a key like
// "__reactFiber$<random>" (the random suffix changes per build/session), so
// we find it by prefix rather than by exact name. From there we walk up and
// down a few levels looking for a TanStack/MRT `row.original` object.

interface FiberNode {
  memoizedProps?: {
    row?: { original?: unknown };
    original?: unknown;
  };
  child?: FiberNode | null;
  return?: FiberNode | null;
}

export interface RowOriginal {
  login?: string;
  firstname?: string;
  lastname?: string;
  [key: string]: unknown;
}

function findFiberKey(domNode: Element): string | undefined {
  return Object.keys(domNode).find(
    (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'),
  );
}

export function extractRowOriginal(trElement: Element, maxDepth = 25): RowOriginal | null {
  const fiberKey = findFiberKey(trElement);
  if (!fiberKey) return null;

  const rootFiber = (trElement as unknown as Record<string, FiberNode>)[fiberKey];
  const visited = new Set<FiberNode>();
  let result: RowOriginal | null = null;

  function search(fiber: FiberNode | null | undefined, depth: number): void {
    if (!fiber || depth > maxDepth || result || visited.has(fiber)) return;
    visited.add(fiber);

    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      if (props.row && props.row.original) {
        result = props.row.original as RowOriginal;
        return;
      }
      if (props.original && typeof props.original === 'object') {
        result = props.original as RowOriginal;
        return;
      }
    }

    search(fiber.child, depth + 1);
    if (result) return;
    search(fiber.return, depth + 1);
  }

  search(rootFiber, 0);
  return result;
}

// Best-effort fallback if the site's internals ever change shape: derive a
// synthetic (non-email) key from the visible name text so tagging degrades
// gracefully instead of silently mis-tagging rows.
export function fallbackKeyFromText(trElement: Element): string | null {
  const text = trElement.textContent || '';
  const normalized = text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
  return normalized ? `name:${normalized}` : null;
}
