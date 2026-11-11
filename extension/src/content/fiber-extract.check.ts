// Self-check for currentFiber: `npx esbuild src/content/fiber-extract.check.ts --bundle --platform=node | node`
import { currentFiber, parentOf, type Fiber } from './fiber-extract';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

// Two copies of root > comp > host, linked as React double-buffers them.
function tree(): { fiberRoot: { current: Fiber }; r: Fiber[]; c: Fiber[]; h: Fiber[] } {
  const fiberRoot = { current: null as unknown as Fiber };
  const r: Fiber[] = [{ stateNode: fiberRoot }, { stateNode: fiberRoot }];
  const c: Fiber[] = [{ memoizedProps: { v: 0 } }, { memoizedProps: { v: 1 } }];
  const h: Fiber[] = [{}, {}];
  for (const [x, y] of [r, c, h]) {
    x.alternate = y;
    y.alternate = x;
  }
  for (const i of [0, 1]) {
    r[i].child = c[i];
    c[i].return = r[i];
    c[i].child = h[i];
    h[i].return = c[i];
  }
  fiberRoot.current = r[0];
  return { fiberRoot, r, c, h };
}

const t = tree();
assert(currentFiber(t.h[0]) === t.h[0], 'current copy kept');
assert(currentFiber(t.h[1]) === t.h[0], 'alternate copy resolved');
t.fiberRoot.current = t.r[1];
assert(currentFiber(t.h[0]) === t.h[1], 'after a commit, the other copy');
// Inconsistent return pointer (current child pointing at the stale parent).
t.h[1].return = t.c[0];
assert((parentOf(t.h[1])?.memoizedProps as { v: number }).v === 1, 'stale return resolved to the committed parent');
assert(currentFiber({}) !== null, 'no alternate: itself');
console.log('fiber-extract.check: ok');
