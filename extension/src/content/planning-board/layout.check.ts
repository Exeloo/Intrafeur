// Self-check for layout.ts (the repo has no test runner):
//   npx esbuild src/content/planning-board/layout.check.ts --bundle --platform=node | node
import { fisheyeLanes, layoutLanes, parisClock, parisToIso, timeToMinutes, viewDays } from './layout';

const assert = {
  deepEqual(actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`expected ${e}, got ${a}`);
  },
  equal(actual: unknown, expected: unknown): void {
    assert.deepEqual(actual, expected);
  },
};

// Paris clock, winter (UTC+1) and summer (UTC+2).
assert.deepEqual(parisClock(Date.parse('2026-11-09T13:00:00Z')), { day: '2026-11-09', minutes: 14 * 60 });
assert.deepEqual(parisClock(Date.parse('2026-07-01T07:30:00Z')), { day: '2026-07-01', minutes: 9 * 60 + 30 });
assert.deepEqual(parisClock(Date.parse('2026-11-09T23:30:00Z')), { day: '2026-11-10', minutes: 30 });

// A week view (FullCalendar range = Paris midnights), and a week crossing the DST switch (25 Oct 2026).
assert.deepEqual(viewDays('2026-11-08T23:00:00.000Z', '2026-11-15T23:00:00.000Z'), [
  '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15',
]);
assert.deepEqual(viewDays('2026-10-18T22:00:00.000Z', '2026-10-25T23:00:00.000Z')[6], '2026-10-25');
assert.equal(viewDays('2026-10-18T22:00:00.000Z', '2026-10-25T23:00:00.000Z').length, 7);
assert.deepEqual(viewDays('2026-11-09T23:00:00.000Z', '2026-11-10T23:00:00.000Z'), ['2026-11-10']);

// Paris wall clock -> UTC: winter, summer, both DST switch days (29 Mar / 25 Oct 2026).
assert.equal(parisToIso('2026-11-09', 14 * 60), '2026-11-09T13:00:00.000Z');
assert.equal(parisToIso('2026-07-01', 9 * 60 + 30), '2026-07-01T07:30:00.000Z');
assert.equal(parisToIso('2026-03-29', 10 * 60), '2026-03-29T08:00:00.000Z');
assert.equal(parisToIso('2026-03-29', 60), '2026-03-29T00:00:00.000Z');
assert.equal(parisToIso('2026-10-25', 10 * 60), '2026-10-25T09:00:00.000Z');
assert.equal(parisToIso('2026-10-25', 23 * 60 + 45), '2026-10-25T22:45:00.000Z');
for (const iso of ['2026-11-09T13:15:00.000Z', '2026-03-29T12:00:00.000Z', '2026-10-25T15:30:00.000Z']) {
  const c = parisClock(Date.parse(iso));
  assert.equal(parisToIso(c.day, c.minutes), iso);
}

assert.equal(timeToMinutes('08:00:00'), 480);
assert.equal(timeToMinutes('23:30'), 1410);

// Lanes: A overlaps B; C overlaps B only; D is alone; E starts when A ends.
const lanes = layoutLanes([
  { id: 1, start: 600, end: 720 }, // A 10:00-12:00
  { id: 2, start: 630, end: 780 }, // B 10:30-13:00
  { id: 3, start: 720, end: 750 }, // C 12:00-12:30 -> reuses A's lane
  { id: 4, start: 900, end: 960 }, // D alone
]);
assert.deepEqual(lanes.get(1), { lane: 0, lanes: 2, cluster: 0 });
assert.deepEqual(lanes.get(2), { lane: 1, lanes: 2, cluster: 0 });
assert.deepEqual(lanes.get(3), { lane: 0, lanes: 2, cluster: 0 });
assert.deepEqual(lanes.get(4), { lane: 0, lanes: 1, cluster: 1 });
// Back to back is not an overlap.
assert.deepEqual(layoutLanes([{ id: 1, start: 0, end: 60 }, { id: 2, start: 60, end: 120 }]).get(2), { lane: 0, lanes: 1, cluster: 1 });
// A 5-minute event still blocks 20 minutes.
assert.deepEqual(layoutLanes([{ id: 1, start: 0, end: 5 }, { id: 2, start: 10, end: 30 }]).get(2), { lane: 1, lanes: 2, cluster: 0 });
// Three identical events: three lanes.
assert.equal(layoutLanes([1, 2, 3].map((id) => ({ id, start: 0, end: 60 }))).get(3)?.lanes, 3);
// Fisheye: 5 lanes, lane 2 hovered -> shares 1,2,4,2,1 of 10.
assert.deepEqual(fisheyeLanes(5, 2).map(([, w]) => w), [0.1, 0.2, 0.4, 0.2, 0.1]);
assert.deepEqual(fisheyeLanes(5, 0).map(([l]) => l), [0, 4 / 9, 6 / 9, 7 / 9, 8 / 9]);
assert.deepEqual(fisheyeLanes(1, 0), [[0, 1]]);

(globalThis as { console?: { log(m: string): void } }).console?.log('layout.check: ok');
