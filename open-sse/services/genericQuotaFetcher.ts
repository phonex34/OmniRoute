/**
 * genericQuotaFetcher.ts — Generic preflight quota fetcher
 *
 * Wraps the existing per-provider usage fetchers in `usage.ts` so that any
 * provider with a `getUsageForProvider` implementation gets per-window
 * preflight enforcement automatically. This is the bridge between the
 * dashboard's "Provider Limits" data (which already supports ~16 providers)
 * and the quotaPreflight system (which previously only had Codex).
 *
 * For providers that ship their own custom QuotaFetcher (Codex, CROF,
 * DeepSeek, Bailian Coding Plan, etc.) the registrar skips them — their
 * bespoke fetchers stay in charge.
 *
 * Each provider's first successful response also populates the static
 * `registerQuotaWindows` registry so other callers (UI window catalog,
 * tests) can discover which windows that provider exposes.
 */

import { getUsageForProvider, USAGE_FETCHER_PROVIDERS } from "./usage.ts";
import { getLatestQuotaSnapshotsForConnection } from "@/lib/db/quotaSnapshots";
import {
  getQuotaFetcher,
  registerQuotaFetcher,
  registerQuotaWindows,
  type QuotaFetcher,
  type QuotaInfo,
} from "./quotaPreflight.ts";

// Adaptive TTL bounds. The old fixed 60s TTL still hit Anthropic's touchy
// usage endpoint ~60x/hour on a chat-heavy account with a cutoff set (one
// fetch per expiry). We now trust the cache far longer when the account is
// nowhere near its cutoff, and only refetch briefly when it approaches one —
// the real 429 → invalidateGenericQuotaCache + cooldown path is the backstop.
const HARD_TTL_CEILING_MS = 90 * 60_000;
const MIN_TTL_MS = 15_000;
const GLOBAL_DEFAULT_MIN_REMAINING_PERCENT = 2;
// Snapshots older than this (written by the quotaCache background tick / the
// 70-min provider-limits sync) are too stale to reuse for preflight.
const SNAPSHOT_REUSE_MAX_AGE_MS = 90 * 60_000;

interface CacheEntry {
  quota: QuotaInfo;
  fetchedAt: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(provider: string, connectionId: string): string {
  return `${provider}::${connectionId}`;
}

const _cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > HARD_TTL_CEILING_MS * 2) cache.delete(key);
  }
}, 5 * 60_000);
if (typeof _cacheCleanup === "object" && "unref" in _cacheCleanup) {
  (_cacheCleanup as { unref?: () => void }).unref?.();
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Compute percentUsed (0-1) for a single quota entry. Prefers the explicit
 * remainingPercentage / used / total fields surfaced by per-provider
 * fetchers (see `usage.ts`). Returns null when the entry is unlimited or
 * doesn't expose enough data to compute a percent — preflight ignores
 * those windows.
 */
function percentUsedForQuota(entry: unknown): number | null {
  if (!entry || typeof entry !== "object") return null;
  const q = entry as Record<string, unknown>;
  if (q.unlimited === true) return null;
  // Upstream explicitly told us it did not report this window's fraction
  // (e.g. Antigravity per-model quota with no usage data yet). Treat as
  // unknown rather than defaulting remainingPercentage:0 into "100% used" —
  // otherwise one unreported model falsely exhausts the whole connection.
  if (q.fractionReported === false) return null;

  const remainingPercentage = toNumber(q.remainingPercentage);
  if (remainingPercentage !== null) {
    // remainingPercentage is 0-100 in the usage.ts contract.
    const used = (100 - Math.max(0, Math.min(100, remainingPercentage))) / 100;
    return used;
  }

  const used = toNumber(q.used);
  const total = toNumber(q.total);
  if (used !== null && total !== null && total > 0) {
    return Math.max(0, Math.min(1, used / total));
  }

  return null;
}

function resetAtForQuota(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const q = entry as Record<string, unknown>;
  return typeof q.resetAt === "string" ? q.resetAt : null;
}

interface ConnectionInputs {
  id?: string;
  provider?: string;
  accessToken?: string;
  apiKey?: string;
  providerSpecificData?: Record<string, unknown>;
  projectId?: string;
  email?: string;
  quotaWindowThresholds?: Record<string, number> | null;
}

/**
 * Per-connection cutoff for a window (0–100 min-remaining %), read from the
 * same `quotaWindowThresholds` map the preflight evaluator uses. Falls back to
 * the 2% global default when unset — a larger headroom → longer TTL, which is
 * the safe direction (over-trusting is caught by the 429 backstop).
 */
function resolveCutoffPercent(conn: ConnectionInputs, windowName: string): number {
  const overrides = conn.quotaWindowThresholds;
  if (overrides && typeof overrides === "object") {
    const n = toNumber(overrides[windowName]);
    if (n !== null && n >= 0 && n <= 100) return n;
  }
  return GLOBAL_DEFAULT_MIN_REMAINING_PERCENT;
}

/** Longer TTL the further the worst window sits above its cutoff. */
function bucketTtlForHeadroom(headroomPercent: number): number {
  if (headroomPercent > 40) return HARD_TTL_CEILING_MS;
  if (headroomPercent > 20) return 15 * 60_000;
  if (headroomPercent > 8) return 3 * 60_000;
  if (headroomPercent > 3) return 45_000;
  return MIN_TTL_MS;
}

/**
 * Adaptive TTL from the worst (closest-to-cutoff) window, clamped to the
 * soonest future resetAt (past the reset the cached numbers describe the old
 * window) and the hard ceiling.
 */
export function computeAdaptiveTtl(quota: QuotaInfo, conn: ConnectionInputs, now: number): number {
  if (quota.limitReached) return MIN_TTL_MS;

  let minHeadroom = Infinity;
  let soonestResetMs: number | null = null;
  const windows = quota.windows || {};
  const names = Object.keys(windows);

  if (names.length === 0) {
    const remaining = Math.max(0, (1 - quota.percentUsed) * 100);
    minHeadroom = remaining - GLOBAL_DEFAULT_MIN_REMAINING_PERCENT;
  } else {
    for (const name of names) {
      const w = windows[name];
      if (!Number.isFinite(w.percentUsed)) continue;
      const remaining = Math.max(0, (1 - w.percentUsed) * 100);
      const headroom = remaining - resolveCutoffPercent(conn, name);
      if (headroom < minHeadroom) minHeadroom = headroom;
      if (w.resetAt) {
        const t = Date.parse(w.resetAt);
        if (Number.isFinite(t) && t > now && (soonestResetMs === null || t < soonestResetMs)) {
          soonestResetMs = t;
        }
      }
    }
  }

  if (!Number.isFinite(minHeadroom)) return MIN_TTL_MS;

  let ttl = Math.min(bucketTtlForHeadroom(minHeadroom), HARD_TTL_CEILING_MS);
  if (soonestResetMs !== null) ttl = Math.min(ttl, Math.max(MIN_TTL_MS, soonestResetMs - now));
  return Math.max(MIN_TTL_MS, ttl);
}

/**
 * Reuse the quota data the background layers already fetched: the
 * `quota_snapshots` table is written every ~1 min by the quotaCache tick and
 * by the 70-min provider-limits sync. Reading it here lets preflight avoid its
 * own upstream call entirely on the common path — the fix for the 429 storm.
 * Returns null when there's no fresh-enough snapshot, so the caller fetches.
 */
function quotaFromRecentSnapshots(connectionId: string, now: number): QuotaInfo | null {
  let rows;
  try {
    rows = getLatestQuotaSnapshotsForConnection(connectionId);
  } catch {
    return null;
  }
  if (!rows || rows.length === 0) return null;

  const quotas: Record<string, { remainingPercentage: number; resetAt: string | null }> = {};
  for (const row of rows) {
    const windowKey = row.window_key;
    if (!windowKey) continue;
    const createdMs = row.created_at ? Date.parse(row.created_at) : NaN;
    if (!Number.isFinite(createdMs) || now - createdMs > SNAPSHOT_REUSE_MAX_AGE_MS) return null;
    quotas[windowKey] = {
      remainingPercentage: Number(row.remaining_percentage ?? 0),
      resetAt: row.next_reset_at ?? null,
    };
  }
  if (Object.keys(quotas).length === 0) return null;
  return convertUsageToQuotaInfo({ quotas });
}

/**
 * Reshape a raw `getUsageForProvider` response into the preflight `QuotaInfo`
 * contract. Returns `null` if there are no measurable windows (all unlimited
 * / shape-unknown / missing). Exported for unit testing — the production path
 * is `fetchGenericQuota`, which adds caching + the upstream call.
 */
export function convertUsageToQuotaInfo(usage: unknown): QuotaInfo | null {
  if (!usage || typeof usage !== "object") return null;
  const usageRecord = usage as Record<string, unknown>;
  if (
    typeof usageRecord.message === "string" &&
    (!usageRecord.quotas || typeof usageRecord.quotas !== "object")
  ) {
    // Provider explicitly told us it couldn't fetch (auth expired, etc.).
    // Fail open — let the request proceed and surface the failure through
    // its normal error path.
    return null;
  }

  const quotasObj = usageRecord.quotas;
  if (!quotasObj || typeof quotasObj !== "object" || Array.isArray(quotasObj)) {
    return null;
  }

  const windows: Record<string, { percentUsed: number; resetAt: string | null }> = {};
  let worstPercent = 0;
  let worstResetAt: string | null = null;
  for (const [name, entry] of Object.entries(quotasObj as Record<string, unknown>)) {
    const percentUsed = percentUsedForQuota(entry);
    if (percentUsed === null) continue;
    const resetAt = resetAtForQuota(entry);
    windows[name] = { percentUsed, resetAt };
    if (percentUsed > worstPercent) {
      worstPercent = percentUsed;
      worstResetAt = resetAt;
    }
  }

  if (Object.keys(windows).length === 0) return null;

  return {
    used: 0,
    total: 0,
    percentUsed: worstPercent,
    resetAt: worstResetAt,
    windows,
    limitReached: worstPercent >= 1 - 1e-9,
  };
}

/**
 * Fetch quota for a connection by delegating to the appropriate
 * provider-specific usage fetcher and reshaping its output into the
 * preflight `QuotaInfo` contract (with a `windows` map for per-window
 * threshold evaluation).
 */
export const fetchGenericQuota: QuotaFetcher = async (connectionId, connection) => {
  if (!connection) return null;
  const conn = connection as ConnectionInputs;
  const provider = typeof conn.provider === "string" ? conn.provider : null;
  if (!provider) return null;

  const key = cacheKey(provider, connectionId);
  const now = Date.now();

  // Tier 1: our own cache, trusted until its adaptive expiry.
  const cached = cache.get(key);
  if (cached && now < cached.expiresAt) {
    return cached.quota;
  }

  // Tier 2: reuse a fresh-enough snapshot the background layers already
  // fetched, so preflight avoids its own upstream usage call on the hot path.
  const fromSnapshot = quotaFromRecentSnapshots(connectionId, now);
  if (fromSnapshot) {
    registerQuotaWindows(provider, Object.keys(fromSnapshot.windows || {}));
    cache.set(key, {
      quota: fromSnapshot,
      fetchedAt: now,
      expiresAt: now + computeAdaptiveTtl(fromSnapshot, conn, now),
    });
    return fromSnapshot;
  }

  // Tier 3: no cache and no recent snapshot — fetch upstream ourselves.
  let usage: unknown;
  try {
    usage = await getUsageForProvider(conn as Parameters<typeof getUsageForProvider>[0]);
  } catch {
    return null;
  }

  const quota = convertUsageToQuotaInfo(usage);
  if (!quota) return null;

  // Refresh the static window catalog so the dashboard can render the right
  // modal inputs without waiting for the user to open the page.
  registerQuotaWindows(provider, Object.keys(quota.windows || {}));

  cache.set(key, { quota, fetchedAt: now, expiresAt: now + computeAdaptiveTtl(quota, conn, now) });
  return quota;
};

/**
 * Force-invalidate the cache for a connection — call after the connection
 * receives an upstream 429 / quota-reset event so the next preflight gets
 * fresh data instead of a 60s stale window.
 */
export function invalidateGenericQuotaCache(provider: string, connectionId: string): void {
  cache.delete(cacheKey(provider, connectionId));
}

/**
 * Register the generic fetcher for every provider that has a usage
 * implementation. Providers with bespoke fetchers (Codex, CROF, DeepSeek,
 * Bailian Coding Plan) MUST be registered before this runs so the defensive
 * `getQuotaFetcher` check below preserves them — see `src/sse/handlers/chat.ts`
 * for the registration order. Idempotent: re-running this is a no-op.
 */
export function registerGenericQuotaFetchers(): void {
  for (const provider of USAGE_FETCHER_PROVIDERS) {
    if (getQuotaFetcher(provider)) continue; // bespoke fetcher already registered — leave it alone
    registerQuotaFetcher(provider, fetchGenericQuota);
  }
}
