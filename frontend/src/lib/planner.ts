// In-browser stop ordering for short outings (an evening of 2–7 stops).
// Exhaustive search is exact and instant at this size. Longer days go through
// the backend OR-Tools planner instead.

export interface PlanStop {
  id: string;
  visitMin: number;
  /** Minutes since midnight; close may exceed 1440 for after-midnight closing. */
  open?: number;
  close?: number;
  /** Natural order within an outing: 1 meal, 2 dessert/coffee, 3 drinks. */
  phase?: number;
}

// Minutes of extra travel worth accepting to keep the natural evening order.
const ORDER_PENALTY_MIN = 45;

export function phaseOf(text: string): number | undefined {
  const t = text.toLowerCase();
  if (/\b(bars?|pubs?|lounge|cocktails?|brewery|club)\b/.test(t)) return 3;
  if (/\b(desserts?|ice cream|gelato|cafe|café|coffee|bakery|tea)\b/.test(t)) return 2;
  if (/(restaurant|hawker|food|dinner|grill|bistro|kitchen|seafood|ramen|noodle)/.test(t)) return 1;
  return undefined;
}

export interface PlannedStop {
  id: string;
  arriveMin: number;
  departMin: number;
  travelMin: number;
  waitMin: number;
  late: boolean; // arrives after the last sensible entry time
}

export interface Plan {
  order: PlannedStop[];
  totalTravelMin: number;
  lateCount: number;
}

export const MAX_STOPS = 7;

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  for (const rest of permutations(n - 1)) {
    for (let i = 0; i <= rest.length; i++) {
      out.push([...rest.slice(0, i), n - 1, ...rest.slice(i)]);
    }
  }
  return out;
}

/**
 * travelMin[0] is the start point, travelMin[k] is stops[k-1]. Null entries
 * (no route) are treated as unreachable.
 */
export function planOuting(
  stops: PlanStop[],
  travelMin: (number | null)[][],
  startMin: number,
): Plan {
  if (stops.length > MAX_STOPS) throw new Error(`At most ${MAX_STOPS} stops`);
  const UNREACHABLE = 24 * 60;
  const t = (i: number, j: number) => travelMin[i][j] ?? UNREACHABLE;

  let best: Plan | null = null;
  let bestCost = Infinity;
  for (const perm of permutations(stops.length)) {
    let clock = startMin;
    let prev = 0;
    let travel = 0;
    let late = 0;
    let wait = 0;
    let inversions = 0;
    let maxPhase = 0;
    const order: PlannedStop[] = [];
    for (const k of perm) {
      const s = stops[k];
      const leg = t(prev, k + 1);
      const arrive = clock + leg;
      const start = Math.max(arrive, s.open ?? 0);
      const isLate = s.close != null && start + s.visitMin > s.close;
      order.push({
        id: s.id,
        arriveMin: start,
        departMin: start + s.visitMin,
        travelMin: leg,
        waitMin: start - arrive,
        late: isLate,
      });
      travel += leg;
      wait += start - arrive;
      late += isLate ? 1 : 0;
      if (s.phase != null) {
        if (s.phase < maxPhase) inversions++;
        maxPhase = Math.max(maxPhase, s.phase);
      }
      clock = start + s.visitMin;
      prev = k + 1;
    }
    // Missing an opening window dominates; then travel, natural order and idle waiting.
    const cost = late * 10_000 + travel + inversions * ORDER_PENALTY_MIN + wait * 0.5;
    if (cost < bestCost) {
      bestCost = cost;
      best = { order, totalTravelMin: travel, lateCount: late };
    }
  }
  return best ?? { order: [], totalTravelMin: 0, lateCount: 0 };
}

export function fmtTime(min: number): string {
  const m = Math.round(min) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
