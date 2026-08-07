/**
 * Read/write helpers for the Antigravity `projectId` stored on a connection row
 * (#8491, #8894).
 *
 * `ensureAntigravityProjectAssigned()` recovers a missing projectId via a
 * `loadCodeAssist` round-trip and hands it back to the caller for the in-flight
 * request only — nothing wrote it back to the connection record, so every
 * subsequent token refresh (or process restart) lost the discovery and forced a
 * fresh round-trip. `persistDiscoveredAntigravityProjectId()` is the single
 * best-effort write path both call sites (`open-sse/executors/antigravity.ts`
 * and the models-discovery normalizer) funnel through, mirroring the shape
 * `mapAntigravityTokens()` already persists at OAuth-exchange time
 * (`src/lib/oauth/providers/antigravity.ts`).
 *
 * `preferAntigravityConnectionsWithStoredProject()` is the read-side counterpart
 * used by reset-aware combo routing: a connection with no stored projectId costs
 * an extra `loadCodeAssist` round-trip on first use, so it is deprioritised out
 * of the quota-aware pool whenever a fully-provisioned sibling exists.
 */

import { updateProviderConnection } from "@/lib/db/providers";

/**
 * Write `discoveredProjectId` onto both the `projectId` column and
 * `providerSpecificData.projectId` for `connectionId`, preserving any other
 * `providerSpecificData` fields already on the connection.
 *
 * Best-effort / non-fatal by design: a persistence failure must never block
 * the in-flight request, which already has the discovered id in hand.
 */
export async function persistDiscoveredAntigravityProjectId(
  connectionId: string | undefined | null,
  discoveredProjectId: string | undefined | null,
  existingProviderSpecificData?: Record<string, unknown> | null
): Promise<void> {
  if (!connectionId || !discoveredProjectId) return;
  try {
    await updateProviderConnection(connectionId, {
      projectId: discoveredProjectId,
      providerSpecificData: {
        ...(existingProviderSpecificData || {}),
        projectId: discoveredProjectId,
      },
    });
  } catch {
    // Non-fatal: persistence failure must never block the in-flight request.
  }
}

/**
 * Narrow `connections` to those carrying a non-empty stored `projectId` (either
 * on the column or mirrored into `providerSpecificData.projectId`).
 *
 * Falls back to the original array when no connection qualifies: an Antigravity
 * account whose projectId has not been discovered yet is still usable (the
 * executor auto-discovers it), so emptying the pool would break routing outright
 * rather than merely making it slower.
 */
export function preferAntigravityConnectionsWithStoredProject<
  T extends Record<string, unknown>,
>(connections: readonly T[]): T[] {
  const withProject = connections.filter((connection) => {
    if (typeof connection.projectId === "string" && connection.projectId.trim() !== "") return true;
    const specific = connection.providerSpecificData as Record<string, unknown> | undefined | null;
    const nested = specific && typeof specific === "object" ? specific.projectId : undefined;
    return typeof nested === "string" && nested.trim() !== "";
  });
  return withProject.length > 0 ? withProject : [...connections];
}
