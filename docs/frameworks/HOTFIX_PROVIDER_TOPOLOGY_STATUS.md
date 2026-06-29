# Hotfix — Provider Topology status (Active / Recent / Error)

Home dashboard → **Provider Topology** panel. Status logic ported from upstream
[9router](https://github.com/decolua/9router/) (the project OmniRoute forked from),
whose status model is correct: **Recent** follows the most-recent request, **Error**
is a short-lived flash that ages out, and **Active** is driven by an in-flight counter.

This hotfix covers two independent bugs across two layers (a 3s REST poll and a
WebSocket feed).

---

## Bug 1 — "failed lâu vẫn hiện đỏ" (stale Error never clears)

### Symptom

A provider that failed once stayed red (`Error`) forever, even after it recovered or
hours passed.

### Root cause

The client recomputed `errorProvider` in `HomePageClient.tsx` using **only**
`lastErrorAt` — the newest error timestamp across the provider's entire history — with:

- no time window (an error from days ago still counted), and
- no check of the provider's _current_ state (`lastStatus`).

Ironically the server route (`/api/provider-metrics`) already had the correct
"must be currently in error" gate (#3619), but the client ignored
`topology.errorProvider` and re-derived it incorrectly.

### Fix

`src/app/(dashboard)/home/topologyUtils.ts` — added a pure helper
`computeTopologyStatus(metrics, normalizeProviderId, now?)` that flags a provider as
`errorProvider` only when **both** hold:

1. its **most recent** request failed (`lastStatus` is non-2xx/3xx) — same gate as the
   server (#3619); and
2. that failure is within `TOPOLOGY_ERROR_TTL_MS`.

`HomePageClient.tsx` now uses this helper instead of the broken `lastErrorAt`-only loop.

### Why 30s TTL (not 9router's 10s)

9router shows Error as a flash that ages out after **10s**, re-evaluated on every SSE
push (~150ms). OmniRoute has no such stream for this panel — it **polls every 3s**. At a
3s cadence a 10s window would survive only ~2–3 polls, too brief to notice. `30s` keeps
the "flash that clears itself" semantics while remaining visible across poll cycles.
Constant: `TOPOLOGY_ERROR_TTL_MS = 30_000` in `topologyUtils.ts`.

Note: `call_logs.timestamp` is written as `new Date().toISOString()` (UTC), so
`Date.now() - Date.parse(lastErrorAt)` is a valid age in ms — no timezone skew.

---

## Bug 2 — "Active xanh dính 60s" (green never clears on completion)

### Symptom

The green `Active` node + animated edge turned **on** when a request started but never
turned **off** when it finished — every request kept a provider green for a full 60s
even if it completed in 2s. Active count was inflated accordingly.

### Root cause

The client hook `useLiveRequests` (`src/hooks/useLiveDashboard.ts`) removes a request
from its active map only on the WS events `request.completed` / `request.failed`. But
the server emitted **only** `request.started` (`chatCore.ts:381`) — there is **no**
`emit("request.completed" | "request.failed" | "request.streaming")` anywhere on the
dashboard event bus (the `notifyWebhookEvent("request.completed")` in `combo.ts` is a
separate webhook system). So the active entry was never removed and green only cleared
via the frontend safety timeout `FE_ACTIVE_TIMEOUT_MS = 60_000`.

### Why we did NOT just wire the missing WS events

Making the WS path symmetric (Option A) was rejected as higher-risk:

- **ID mismatch** — `request.started` emits `id: traceId` (6-char), but the symmetric
  "request ended" call `trackPendingRequest(...)` returns a different `pendingRequestId`.
  Matching them would require threading `traceId` through every exit.
- **~13 non-streaming exit points** + a separate streaming-finalize path, all inside a
  ~3850-line hot-path streaming function.
- **Streaming timing** — for streamed responses the request is not "done" when
  `handleChatCore` returns; a naive emit would clear green mid-stream.

### Fix (Option B — drive Active from the existing pending counter, like 9router)

OmniRoute already maintains a balanced in-flight counter in `trackPendingRequest`
(`src/lib/usage/usageHistory.ts`) — incremented on start and decremented at all ~13
exits + the streaming finalize + the stale sweep. This is the same source of truth
9router uses for "active". We surface it instead of relying on the half-wired WS events.

| Layer                             | Change                                                                                                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usageHistory.ts`                 | Added `pendingRequests.byProvider` bucket mirroring `byModel`'s +1/−1 lifecycle exactly (in `trackPendingRequest`, `decrementPendingCounters` for finalize + sweep, and `clearPendingRequests`). Added `getPendingProviderCounts()` (returns a copy). Provider key is lowercased. |
| `usageDb.ts`                      | Re-export `getPendingProviderCounts`.                                                                                                                                                                                                                                             |
| `/api/provider-metrics`           | Response now includes `pending: { [provider]: count }` and `topology.activeProviders`. All previous fields unchanged (additive).                                                                                                                                                  |
| `HomePageClient.tsx`              | Derives `activeRequests` from the polled `pending` map (provider with count > 0 = active); passes it to the topology. Stops feeding the topology from `useLiveRequests`.                                                                                                          |
| `HomeProviderTopologySection.tsx` | Accepts `activeRequests` as a prop instead of opening its own WS via `useLiveRequests`.                                                                                                                                                                                           |
| `ProviderTopology.tsx`            | Trusts the poll-authoritative `activeSet` as-is; **removed** the `firstSeenRef` time-clip and the 60s/`FE_ACTIVE_*` machinery.                                                                                                                                                    |

### Behaviour after fix

- **Multi-provider** → multiple green nodes. `byProvider` counts each provider
  independently and aggregates a provider's concurrent requests across models/accounts.
- **Provider switch** (combo target hop) → old provider drops to 0 (loses green), new
  provider +1 (gains green).
- **Clears on completion** → counter hits 0 on request end (success or fail); green
  disappears on the next poll, so **≤ ~3s** lag instead of a stuck 60s.

### Why the time-clip was removed (not just shortened)

The old `firstSeenRef` clip measured "time since first seen" and never reset while a
provider stayed active. With poll-authoritative data that would wrongly kill the green
of a continuously-busy provider or a long (>clip) streaming request. The poll set
self-clears when pending hits 0, so the clip is unnecessary and harmful.

### Safety net

Counter leaks (an increment with no matching decrement) are bounded by the existing
**server-side stale sweep** in `usageHistory.ts` (`sweepStalePendingRequests`, default
~1h max age, runs every ~5 min), which now also decrements `byProvider`. This is the
real backstop — there is no longer a frontend timeout.

---

## Files changed

- `src/lib/usage/usageHistory.ts` — `byProvider` counter + `getPendingProviderCounts()`
- `src/lib/usageDb.ts` — re-export
- `src/app/api/provider-metrics/route.ts` — `pending` + `activeProviders` in response
- `src/app/(dashboard)/home/topologyUtils.ts` — `computeTopologyStatus()` + `TOPOLOGY_ERROR_TTL_MS`
- `src/app/(dashboard)/dashboard/HomePageClient.tsx` — use helper + poll-derived active
- `src/app/(dashboard)/dashboard/HomeProviderTopologySection.tsx` — `activeRequests` prop
- `src/app/(dashboard)/home/ProviderTopology.tsx` — trust poll set, drop time-clip

## Tests

- `tests/unit/topology-status-ttl.test.ts` — Error TTL expiry, currently-in-error gate, recent selection
- `tests/unit/pending-provider-counts.test.ts` — `byProvider` start/end balance, aggregation, lowercase, copy isolation, sweep decrement
- `tests/unit/ui/home-provider-topology-section-4606.test.tsx` — forwards poll-derived `activeRequests`

## Compatibility notes

- All API changes are **additive** — existing consumers of `/api/provider-metrics`
  (`metrics`, `topology.lastProvider/errorProvider/providers`) are unaffected.
- `useLiveRequests` and `selectActiveRequests` remain for the separate "Live Requests"
  feed; only the topology stopped consuming them.
- No hot-path streaming logic in `chatCore.ts` was modified.
