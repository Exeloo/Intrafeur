// Planning board: pure time/layout helpers (no DOM). All times are Paris
// wall-clock, like the intranet, whatever the browser's time zone (Intl
// handles DST). Checked by layout.check.ts.

const parisFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Paris day ("2026-11-09") and minutes since that day's midnight. */
export function parisClock(ms: number): { day: string; minutes: number } {
  const parts: Record<string, string> = {};
  for (const p of parisFormat.formatToParts(ms)) parts[p.type] = p.value;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Inverse of parisClock: a Paris wall-clock day + minutes -> UTC ISO string. */
export function parisToIso(day: string, minutes: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d) + minutes * 60_000;
  // Start at UTC+1 and correct by the observed difference (twice: DST edges).
  let guess = target - 3600_000;
  for (let i = 0; i < 2; i++) {
    const c = parisClock(guess);
    const [cy, cm, cd] = c.day.split('-').map(Number);
    guess += target - (Date.UTC(cy, cm - 1, cd) + c.minutes * 60_000);
  }
  return new Date(guess).toISOString();
}

/** The Paris days of a [start, end) view range (FullCalendar's activeStart/End). */
export function viewDays(startIso: string, endIso: string): string[] {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const days: string[] = [];
  // Noon of each day: never ambiguous across a DST switch.
  for (let t = start + 12 * 3600_000; t < end && days.length < 42; t += 24 * 3600_000) {
    const { day } = parisClock(t);
    if (days[days.length - 1] !== day) days.push(day);
  }
  return days;
}

/** "08:00:00" -> 480 */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export interface Span {
  id: number;
  start: number;
  end: number;
}

/**
 * Side-by-side lanes for one day's events: overlapping events form a
 * cluster, each gets the first free lane, and every event of a cluster
 * shares its lane count (equal widths). `minDuration` keeps very short
 * events (drawn taller than they are) from visually colliding.
 */
export function layoutLanes(spans: Span[], minDuration = 20): Map<number, { lane: number; lanes: number }> {
  const out = new Map<number, { lane: number; lanes: number }>();
  const sorted = spans
    .map((s) => ({ ...s, end: Math.max(s.end, s.start + minDuration) }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.id - b.id);
  let cluster: { id: number; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = (): void => {
    for (const c of cluster) out.set(c.id, { lane: c.lane, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };
  for (const s of sorted) {
    if (s.start >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((end) => end <= s.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(s.end);
    } else {
      laneEnds[lane] = s.end;
    }
    cluster.push({ id: s.id, lane });
    clusterEnd = Math.max(clusterEnd, s.end);
  }
  flush();
  return out;
}
