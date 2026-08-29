import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-snapshot-persist-"));

const { setProviderLimitsCache, getProviderLimitsCache } =
  await import("../../src/lib/db/providerLimits.ts");
const { saveQuotaSnapshot } = await import("../../src/lib/db/quotaSnapshots.ts");
const { snapshotCacheEntry, syncAllProviderLimits } =
  await import("../../src/lib/usage/providerLimits.ts");
const providersDb = await import("../../src/lib/db/providers.ts");

const CONN = "snapshot-persist-conn-1";

// Core bug being locked: quota_snapshots keeps advancing (background writer, ~5min)
// but the key_value providerLimitsCache — the ONLY thing a tab reload reads — stayed
// frozen whenever "Refresh now" hit a 429, because the fallback path served the fresh
// snapshot to the UI without ever writing it back. snapshotCacheEntry is the freshness
// gate the persist decision relies on: it must return the newer snapshot (so the caller
// persists it) and must reject a snapshot that is not strictly newer than key_value.

test("snapshotCacheEntry returns the snapshot when it is strictly newer than key_value", () => {
  const oldFetchedAt = "2026-07-08T08:55:00.000Z";
  setProviderLimitsCache(CONN, {
    quotas: {
      "session (5h)": {
        used: 46,
        total: 100,
        remaining: 54,
        remainingPercentage: 54,
        resetAt: "2026-07-08T11:30:00.000Z",
        unlimited: false,
      },
    },
    plan: null,
    message: null,
    fetchedAt: oldFetchedAt,
    source: "manual",
  });

  saveQuotaSnapshot({
    provider: "claude",
    connection_id: CONN,
    window_key: "session (5h)",
    remaining_percentage: 33,
    is_exhausted: 0,
    next_reset_at: "2026-07-08T11:30:00.000Z",
    window_duration_ms: null,
    raw_data: null,
  });

  const previous = getProviderLimitsCache(CONN);
  const snapshot = snapshotCacheEntry(CONN, previous);

  assert.ok(snapshot, "a strictly-newer snapshot must be returned so the caller can persist it");
  assert.equal(
    (snapshot!.quotas as Record<string, { remainingPercentage: number }>)["session (5h)"]
      .remainingPercentage,
    33,
    "the returned entry must carry the fresh snapshot percentage, not the stale 54"
  );
  assert.ok(
    Date.parse(snapshot!.fetchedAt) > Date.parse(previous!.fetchedAt),
    "the returned entry's fetchedAt must be newer than the frozen key_value entry"
  );
});

test("snapshotCacheEntry rejects a snapshot that is not strictly newer than key_value", () => {
  const conn2 = "snapshot-persist-conn-2";
  saveQuotaSnapshot({
    provider: "claude",
    connection_id: conn2,
    window_key: "session (5h)",
    remaining_percentage: 40,
    is_exhausted: 0,
    next_reset_at: "2026-07-08T11:30:00.000Z",
    window_duration_ms: null,
    raw_data: null,
  });

  // key_value stamped far in the future → newer than any snapshot we just wrote.
  setProviderLimitsCache(conn2, {
    quotas: {
      "session (5h)": {
        used: 20,
        total: 100,
        remaining: 80,
        remainingPercentage: 80,
        resetAt: "2026-07-08T11:30:00.000Z",
        unlimited: false,
      },
    },
    plan: null,
    message: null,
    fetchedAt: "2030-01-01T00:00:00.000Z",
    source: "manual",
  });

  const previous = getProviderLimitsCache(conn2);
  const snapshot = snapshotCacheEntry(conn2, previous);
  assert.equal(
    snapshot,
    null,
    "a snapshot older than key_value must be rejected so persist never overwrites fresher data"
  );
});

test("both fetch-failure fallback paths persist a fresh snapshot back to key_value", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/usage/providerLimits.ts"), "utf8");
  // fetchAndPersistProviderLimits (single "Refresh now") must write the snapshot.
  assert.match(
    source,
    /if \(snapshot\) \{\s*setProviderLimitsCache\(connectionId, snapshot\);/,
    "single-connection fallback must persist a fresh snapshot to key_value"
  );
  // syncAllProviderLimits ("Refresh All") must batch the snapshot for persistence.
  assert.match(
    source,
    /if \(snapshot\) \{\s*cacheEntries\.push\(\{ connectionId, entry: snapshot \}\);/,
    "bulk fallback must batch a fresh snapshot for key_value persistence"
  );
});

test("syncAllProviderLimits (batch/Refresh-All) persists a fresher snapshot instead of re-pushing a stale mergeProviderLimitsCacheEntry(previous) result", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: `Codex Batch Snapshot ${Date.now()}`,
    accessToken: "codex-batch-snapshot-access-token",
    refreshToken: "codex-batch-snapshot-refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const connectionId = (connection as { id: string }).id;

  // Prior key_value entry: usable (has quotas), frozen at an old timestamp —
  // mergeProviderLimitsCacheEntry's hasUsableCachedData() gate will treat this
  // as "keep serving it" on a failed fetch, returning it BY IDENTITY.
  setProviderLimitsCache(connectionId, {
    quotas: { "session (5h)": { used: 46, total: 100, remainingPercentage: 54 } },
    plan: "pro",
    message: null,
    fetchedAt: "2026-07-08T08:55:00.000Z",
    source: "scheduled",
  });

  // A newer quota_snapshots row exists (background writer advanced since the
  // key_value entry froze) — this is what the fallback should pick up.
  saveQuotaSnapshot({
    provider: "codex",
    connection_id: connectionId,
    window_key: "session (5h)",
    remaining_percentage: 33,
    is_exhausted: 0,
    next_reset_at: "2026-07-08T11:30:00.000Z",
    window_duration_ms: null,
    raw_data: null,
  });

  const previousFetch = globalThis.fetch;
  // 401 → Codex's fetcher returns { message: "..." } with no `quotas`, no
  // throw. mergeProviderLimitsCacheEntry then sees hasUsableCachedData(prior)
  // === true and returns `previous` BY IDENTITY (cache === previous), NOT a
  // `{ quotas: undefined, message }` shape — this is the case the plain
  // `!cache.quotas && cache.message` guard misses.
  globalThis.fetch = (async () =>
    new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    await syncAllProviderLimits({ source: "manual" });
  } finally {
    globalThis.fetch = previousFetch;
  }

  const persisted = getProviderLimitsCache(connectionId);
  assert.ok(persisted, "a cache entry must still exist after the batch sync");
  assert.equal(
    (persisted!.quotas as Record<string, { remainingPercentage: number }>)["session (5h)"]
      .remainingPercentage,
    33,
    "key_value must be upgraded to the fresher quota_snapshots percentage (33), " +
      "not left frozen at the stale 54 — proves cache === previous is detected " +
      "and the snapshot fallback runs instead of re-pushing the stale merged entry"
  );
  assert.ok(
    Date.parse(persisted!.fetchedAt) > Date.parse("2026-07-08T08:55:00.000Z"),
    "persisted fetchedAt must advance past the frozen key_value timestamp"
  );
});
