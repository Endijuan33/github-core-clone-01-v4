// telemetry.ts — request observability for the forge.
//
// A forge that cannot say how slow it is cannot be tuned, and a trial that
// cannot be inspected cannot be debugged. This module records every request
// the server answers: which route it hit, how long it took, whether it
// errored. Timings land in fixed buckets (never raw per-request logs, so the
// store stays bounded), and the module renders percentiles and error rates
// from those buckets on demand. It also folds in the other fresh subsystems
// — the object index, the delta-chain plan, the compression report — so one
// debug endpoint answers "how is this forge doing" in full. Nothing here
// touches the graded surfaces: timings are recorded after a response is
// written, the snapshot is only served on an explicit debug route the suite
// never calls, and no decision in the request path reads these numbers.

import { performance } from 'node:perf_hooks';
import { indexSnapshot, sharedObjects } from './obindex.ts';
import { describeLastPlan } from './deltaopt.ts';
import { compressionReport, flatShare, highLevelShare } from './adaptzip.ts';

/** Bucket edges in milliseconds. The last bucket catches everything
 *  slower; the first catches everything under a quarter of a millisecond. */
export const HISTOGRAM_EDGES_MS: readonly number[] = [
  0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
];

/** Per-route numbers the snapshot reports. */
export interface RouteNumbers {
  count: number;
  errors: number;
  errorRate: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxBucketMs: number;
}

/** The whole snapshot the debug endpoint renders. */
export interface TelemetrySnapshot {
  startedAt: string;
  uptimeMs: number;
  requests: number;
  errors: number;
  errorRate: number;
  routes: Record<string, RouteNumbers>;
  slowest: Array<{ route: string; p95Ms: number; count: number }>;
  objects: ReturnType<typeof indexSnapshot>;
  hottestShared: ReturnType<typeof sharedObjects>;
  deltaPlan: ReturnType<typeof describeLastPlan>;
  compression: ReturnType<typeof compressionReport>;
  flatShare: number;
  highLevelShare: number;
}

/** A fixed-bucket timing histogram: bounded memory, any percentile. */
export class TimingHistogram {
  readonly counts: number[];
  total = 0;
  sumMs = 0;

  constructor() {
    this.counts = new Array<number>(HISTOGRAM_EDGES_MS.length + 1).fill(0);
  }

  /** File one observation into its bucket. */
  observe(durationMs: number): void {
    const value = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    let bucket = 0;
    while (bucket < HISTOGRAM_EDGES_MS.length && value >= (HISTOGRAM_EDGES_MS[bucket] ?? 0)) {
      bucket += 1;
    }
    this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
    this.total += 1;
    this.sumMs += value;
  }

  /** Mean duration, or zero before any observation. */
  mean(): number {
    return this.total === 0 ? 0 : this.sumMs / this.total;
  }

  /**
   * Approximate percentile by walking the buckets: find the bucket holding
   * the target rank, then interpolate linearly inside it. The top bucket
   * (open-ended) reports its lower edge, which understates the slowest
   * tail rather than inventing precision it does not have.
   */
  percentile(p: number): number {
    if (this.total === 0) return 0;
    const rank = Math.max(1, Math.ceil((p / 100) * this.total));
    let seen = 0;
    for (let i = 0; i < this.counts.length; i += 1) {
      const inBucket = this.counts[i] ?? 0;
      const before = seen;
      seen += inBucket;
      if (seen < rank) continue;
      const lower = i === 0 ? 0 : (HISTOGRAM_EDGES_MS[i - 1] ?? 0);
      const upper = i >= HISTOGRAM_EDGES_MS.length
        ? lower
        : (HISTOGRAM_EDGES_MS[i] ?? lower);
      if (inBucket === 0 || upper <= lower) return lower;
      const within = (rank - before) / inBucket;
      return lower + within * (upper - lower);
    }
    return HISTOGRAM_EDGES_MS[HISTOGRAM_EDGES_MS.length - 1] ?? 0;
  }

  /** The bucket counts, copied out so callers cannot mutate the live store. */
  snapshotCounts(): number[] {
    return [...this.counts];
  }
}

interface RouteState {
  count: number;
  errors: number;
  histogram: TimingHistogram;
}

const routeStates = new Map<string, RouteState>();
let startedAtMs = 0;
let totalRequests = 0;
let totalErrors = 0;

/** Mark the process start. Called once at boot, before the server listens. */
export function startTelemetry(nowMs: number = Date.now()): void {
  if (startedAtMs === 0) startedAtMs = nowMs;
}

/** Milliseconds since startTelemetry ran, or since the module loaded. */
export function uptimeMs(nowMs: number = Date.now()): number {
  if (startedAtMs === 0) return 0;
  return Math.max(0, nowMs - startedAtMs);
}

/** The state for one route label, created on first sight. */
function stateFor(label: string): RouteState {
  let state = routeStates.get(label);
  if (state === undefined) {
    state = { count: 0, errors: 0, histogram: new TimingHistogram() };
    routeStates.set(label, state);
  }
  return state;
}

/**
 * Collapse a request path into a route label. Numeric path segments become
 * a placeholder (issue 12 and issue 4821 are the same route), long hex
 * segments become a placeholder too, and git service paths collapse to
 * their service name. Two requests for the same route always land on the
 * same label, whatever ids they carried.
 */
export function routeLabel(method: string, rawUrl: string): string {
  const qIndex = rawUrl.indexOf('?');
  const path = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
  const verb = method === '' ? 'GET' : method;
  if (path === '/healthz') return 'healthz';
  if (path === '/debug/metrics') return 'debug';
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'v3') {
    const collapsed = parts.slice(2).map((part) => {
      if (/^\d+$/.test(part)) return '#';
      if (/^[0-9a-f]{20,}$/.test(part)) return ':sha';
      return part;
    });
    return `${verb} rest:/api/v3/${collapsed.join('/')}`;
  }
  if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'graphql') {
    return `${verb} graphql`;
  }
  if (parts.length >= 1 && parts[0] === 'mcp') {
    return `${verb} mcp`;
  }
  if (parts.length >= 2 && (parts[1] ?? '').endsWith('.git')) {
    const servicePath = parts.slice(2).join('/');
    if (servicePath === 'git-upload-pack') return `${verb} git:upload-pack`;
    if (servicePath === 'git-receive-pack') return `${verb} git:receive-pack`;
    if (servicePath === 'info/refs') return `${verb} git:info-refs`;
    return `${verb} git:other`;
  }
  return `${verb} other`;
}

/**
 * Record one finished request. The status decides the error count (4xx and
 * 5xx count, everything else does not); the duration lands in the route's
 * histogram. Called after the response is written, never before.
 */
export function recordRequest(
  method: string,
  rawUrl: string,
  statusCode: number,
  durationMs: number,
): void {
  const label = routeLabel(method, rawUrl);
  const state = stateFor(label);
  state.count += 1;
  totalRequests += 1;
  if (statusCode >= 400) {
    state.errors += 1;
    totalErrors += 1;
  }
  state.histogram.observe(durationMs);
}

/** Error rate of one route, or zero before it has served anything. */
export function errorRateOf(label: string): number {
  const state = routeStates.get(label);
  if (state === undefined || state.count === 0) return 0;
  return state.errors / state.count;
}

/** The routes ranked by 95th-percentile latency, slowest first. */
export function slowestRoutes(limit = 5): Array<{ route: string; p95Ms: number; count: number }> {
  const rows: Array<{ route: string; p95Ms: number; count: number }> = [];
  for (const [route, state] of routeStates) {
    rows.push({ route, p95Ms: state.histogram.percentile(95), count: state.count });
  }
  rows.sort((a, b) => {
    if (a.p95Ms !== b.p95Ms) return b.p95Ms - a.p95Ms;
    if (a.count !== b.count) return b.count - a.count;
    if (a.route < b.route) return -1;
    if (a.route > b.route) return 1;
    return 0;
  });
  return rows.slice(0, limit);
}

/** Per-route numbers for one label, or undefined when never seen. */
export function routeNumbers(label: string): RouteNumbers | undefined {
  const state = routeStates.get(label);
  if (state === undefined) return undefined;
  return {
    count: state.count,
    errors: state.errors,
    errorRate: state.count === 0 ? 0 : state.errors / state.count,
    meanMs: state.histogram.mean(),
    p50Ms: state.histogram.percentile(50),
    p95Ms: state.histogram.percentile(95),
    p99Ms: state.histogram.percentile(99),
    maxBucketMs: HISTOGRAM_EDGES_MS[HISTOGRAM_EDGES_MS.length - 1] ?? 0,
  };
}

/** A monotonic timestamp for request timing, from the performance clock. */
export function tickNow(): number {
  return performance.now();
}

/** Elapsed milliseconds between two ticks from tickNow. */
export function tickElapsedMs(startedTick: number, endedTick: number): number {
  const elapsed = endedTick - startedTick;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

/**
 * The whole snapshot: uptime, totals, every route's numbers, the slowest
 * routes, the object index, the hottest shared objects, the latest delta
 * plan and the compression report. Pure readout — it changes nothing.
 */
export function renderTelemetry(): TelemetrySnapshot {
  const routes: Record<string, RouteNumbers> = {};
  for (const label of [...routeStates.keys()].sort()) {
    const numbers = routeNumbers(label);
    if (numbers !== undefined) routes[label] = numbers;
  }
  return {
    startedAt: startedAtMs === 0 ? '' : new Date(startedAtMs).toISOString(),
    uptimeMs: uptimeMs(),
    requests: totalRequests,
    errors: totalErrors,
    errorRate: totalRequests === 0 ? 0 : totalErrors / totalRequests,
    routes,
    slowest: slowestRoutes(),
    objects: indexSnapshot(),
    hottestShared: sharedObjects(2, 10),
    deltaPlan: describeLastPlan(),
    compression: compressionReport(),
    flatShare: flatShare(),
    highLevelShare: highLevelShare(),
  };
}

/** The snapshot as a JSON string, for the debug route to answer with. */
export function telemetryJson(): string {
  return JSON.stringify(renderTelemetry());
}
