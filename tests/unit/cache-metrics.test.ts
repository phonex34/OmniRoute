import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getCacheMetrics } from "../../src/lib/db/settings.ts";
import { getDbInstance } from "../../src/lib/db/core.ts";

describe("Cache Metrics Database", () => {
  let db;

  before(() => {
    db = getDbInstance();
    // Create usage_history table if it doesn't exist (mimicking production schema)
    db.prepare(
      `
      CREATE TABLE IF NOT EXISTS usage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT,
        model TEXT,
        connection_id TEXT,
        api_key_id TEXT,
        api_key_name TEXT,
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        tokens_cache_read INTEGER DEFAULT 0,
        tokens_cache_creation INTEGER DEFAULT 0,
        tokens_reasoning INTEGER DEFAULT 0,
        status TEXT,
        timestamp TEXT,
        success INTEGER,
        latency_ms INTEGER DEFAULT 0,
        ttft_ms INTEGER DEFAULT 0,
        error_code TEXT
      )
    `
    ).run();
  });

  after(async () => {
    // Clean up test data
    db.prepare("DELETE FROM usage_history WHERE provider = 'test-provider'").run();
  });

  describe("getCacheMetrics", () => {
    test("returns metrics even with no cache activity", async () => {
      // Verify the function works even if usage_history has data but no cache activity
      const metrics = await getCacheMetrics();

      assert.ok(metrics.totalRequests >= 0);
      assert.ok(metrics.totalInputTokens >= 0);
      assert.ok(metrics.totalCachedTokens >= 0);
      assert.ok(metrics.totalCacheCreationTokens >= 0);
      assert.ok(metrics.tokensSaved >= 0);
      assert.ok(metrics.lastUpdated);
    });

    test("returns aggregated metrics from usage_history", async () => {
      // Clean up any existing test data first
      db.prepare("DELETE FROM usage_history WHERE provider = 'test-provider'").run();

      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name,
          tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning,
          status, success, latency_ms, ttft_ms, error_code, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        "test-provider",
        "test-model",
        "test-connection",
        "test-key-id",
        "test-key",
        1000, // tokens_input
        500, // tokens_output
        400, // tokens_cache_read
        200, // tokens_cache_creation
        0, // tokens_reasoning
        "200", // status
        1, // success
        100, // latency_ms
        50, // ttft_ms
        null, // error_code
        now // timestamp
      );

      // Insert another row
      db.prepare(
        `
        INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name,
          tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning,
          status, success, latency_ms, ttft_ms, error_code, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        "test-provider",
        "test-model",
        "test-connection",
        "test-key-id",
        "test-key",
        500, // tokens_input
        300, // tokens_output
        200, // tokens_cache_read
        100, // tokens_cache_creation
        0, // tokens_reasoning
        "200", // status
        1, // success
        80, // latency_ms
        40, // ttft_ms
        null, // error_code
        now // timestamp
      );

      const metrics = await getCacheMetrics();

      // Should have at least the 2 test requests with cache activity
      assert.ok(metrics.requestsWithCacheControl >= 2);
      assert.ok(metrics.totalInputTokens >= 1500);
      assert.ok(metrics.totalCachedTokens >= 600);
      assert.ok(metrics.totalCacheCreationTokens >= 300);
      assert.ok(metrics.tokensSaved >= 600);

      // Check provider breakdown
      assert.ok(metrics.byProvider["test-provider"]);
      assert.ok(metrics.byProvider["test-provider"].requests >= 2);
      assert.ok(metrics.byProvider["test-provider"].totalRequests >= 2);
      assert.ok(metrics.byProvider["test-provider"].cachedRequests >= 2);
      assert.ok(metrics.byProvider["test-provider"].inputTokens >= 1500);
      assert.ok(metrics.byProvider["test-provider"].cachedTokens >= 600);
      assert.ok(metrics.byProvider["test-provider"].cacheCreationTokens >= 300);

      // Clean up
      db.prepare("DELETE FROM usage_history WHERE provider = 'test-provider'").run();
    });

    test("keeps a known-subset denominator when a row never reported cache tokens", async () => {
      // #20271: a provider that omits the cache counter stores NULL, not a measured 0.
      // One such row must not erase the provider's rate: the denominator is the rows
      // that DID report it.
      db.prepare("DELETE FROM usage_history WHERE provider = 'partial-provider'").run();
      const insert = db.prepare(`
        INSERT INTO usage_history (provider, model, tokens_input, tokens_cache_read,
          tokens_cache_creation, timestamp)
        VALUES (?, 'partial-model', ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      insert.run("partial-provider", 1000, 900, 0, now);
      insert.run("partial-provider", 500, 100, 0, now);
      insert.run("partial-provider", 700, null, null, now);
      // Write-only evidence: the provider reported a cache write but never a read.
      // It must stay out of both the hit count and the read denominator, or the rate
      // would exceed 100%.
      insert.run("partial-provider", 1000, null, 500, now);

      const metrics = await getCacheMetrics();
      const partial = metrics.byProvider["partial-provider"];

      assert.equal(partial.cachedTokens, 1000);
      assert.equal(partial.inputTokensWithKnownCacheRead, 1500);
      assert.equal(partial.requestsWithKnownCacheRead, 2);
      assert.equal(partial.cacheReadRequests, 2);
      assert.ok(partial.cacheReadRequests <= partial.requestsWithKnownCacheRead);
      assert.equal(partial.cachedRequests, 3, "activity count still sees the write-only row");
      assert.equal(partial.cachedTokensComplete, false);
      assert.equal(partial.totalRequests, 4);

      db.prepare("DELETE FROM usage_history WHERE provider = 'partial-provider'").run();
    });
  });
});
