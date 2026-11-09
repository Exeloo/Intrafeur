// One MutationObserver per bundle (per world) instead of one per feature:
// every feature subscribes its `check()` here. Each subscriber is throttled
// on its own (never a restart-on-every-mutation debounce: the site rewrites
// <style> tags every ~100 ms on some views, so a debounce never fires — see
// CLAUDE.md), with setTimeout (rAF stalls in unfocused tabs).
//
// A subscriber only wakes on what it asked for: childList always, plus
// characterData and the attribute names it listed (on <html> and/or under
// <body>). Never re-render already-processed DOM on every check: a check
// that writes to the DOM triggers the next mutation, so only write on
// genuine change.
type Sub = {
  check: () => void;
  delay: number;
  characterData: boolean;
  attributes: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
};

export interface WatchOptions {
  /** Throttle delay in ms (default 150). */
  delay?: number;
  /** Also wake on text changes under <body>. */
  characterData?: boolean;
  /** Attribute names on <html> to wake on (e.g. a mirrored data-epitools-* flag). */
  htmlAttributes?: string[];
  /** Attribute names under <body> to wake on. */
  bodyAttributes?: string[];
  /** Run `check()` once right away (default true). */
  runNow?: boolean;
}

const subs = new Set<Sub>();
let bodyObserver: MutationObserver | null = null;
let htmlObserver: MutationObserver | null = null;

function wake(records: MutationRecord[], root: 'html' | 'body'): void {
  let childList = false;
  let characterData = false;
  const attrs = new Set<string>();
  for (const r of records) {
    if (r.type === 'childList') childList = true;
    else if (r.type === 'characterData') characterData = true;
    else if (r.attributeName) attrs.add(r.attributeName);
  }
  for (const sub of subs) {
    const hit =
      (root === 'body' && (childList || (characterData && sub.characterData))) ||
      [...attrs].some((a) => sub.attributes.has(a));
    if (hit) schedule(sub);
  }
}

function schedule(sub: Sub): void {
  if (sub.timer !== undefined) return;
  sub.timer = setTimeout(() => {
    sub.timer = undefined;
    if (!subs.has(sub)) return;
    try {
      sub.check();
    } catch (err) {
      console.error('[Intrafeur]', err);
    }
  }, sub.delay);
}

// (Re)observes with the union of what the subscribers want; calling
// observe() again on the same target replaces the previous options.
function reobserve(htmlAttrs: Set<string>, bodyAttrs: Set<string>, characterData: boolean): void {
  if (!subs.size) {
    bodyObserver?.disconnect();
    htmlObserver?.disconnect();
    bodyObserver = htmlObserver = null;
    return;
  }
  bodyObserver ??= new MutationObserver((r) => wake(r, 'body'));
  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData,
    ...(bodyAttrs.size ? { attributes: true, attributeFilter: [...bodyAttrs] } : {}),
  });
  if (htmlAttrs.size) {
    htmlObserver ??= new MutationObserver((r) => wake(r, 'html'));
    htmlObserver.observe(document.documentElement, { attributes: true, attributeFilter: [...htmlAttrs] });
  } else {
    htmlObserver?.disconnect();
    htmlObserver = null;
  }
}

const htmlAttrsOf = new Map<Sub, string[]>();
const bodyAttrsOf = new Map<Sub, string[]>();

function refresh(): void {
  const html = new Set<string>();
  const body = new Set<string>();
  let characterData = false;
  for (const sub of subs) {
    for (const a of htmlAttrsOf.get(sub) ?? []) html.add(a);
    for (const a of bodyAttrsOf.get(sub) ?? []) body.add(a);
    characterData ||= sub.characterData;
  }
  reobserve(html, body, characterData);
}

/** Subscribes `check`; returns an unsubscribe function. */
export function watchDom(check: () => void, opts: WatchOptions = {}): () => void {
  const sub: Sub = {
    check,
    delay: opts.delay ?? 150,
    characterData: !!opts.characterData,
    attributes: new Set([...(opts.htmlAttributes ?? []), ...(opts.bodyAttributes ?? [])]),
  };
  subs.add(sub);
  htmlAttrsOf.set(sub, opts.htmlAttributes ?? []);
  bodyAttrsOf.set(sub, opts.bodyAttributes ?? []);
  refresh();
  if (opts.runNow !== false) schedule(sub);
  return () => {
    if (!subs.delete(sub)) return;
    if (sub.timer !== undefined) clearTimeout(sub.timer);
    htmlAttrsOf.delete(sub);
    bodyAttrsOf.delete(sub);
    refresh();
  };
}

/** Converts a dataset key ("epitoolsEvalSheet") to its attribute name ("data-epitools-eval-sheet"). */
export function datasetAttr(datasetKey: string): string {
  return 'data-' + datasetKey.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}
