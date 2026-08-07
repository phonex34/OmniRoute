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
/**
 * Selection-side companion of the persistence write path (#8894): given a pool
 * of Antigravity/AGY connections, prefer the ones that already carry a stored
 * projectId — they can serve a request without the `loadCodeAssist` discovery
 * round-trip. "Prefer", not "require": when NO connection has a stored project
 * the pool is returned unchanged, so a fresh install never empties its
 * candidate list.
 *
 * Sync on purpose (called inside the quota-strategy connection expansion, which
 * builds candidate lists without awaiting per-connection work). Tolerates
 * `providerSpecificData` arriving either parsed or as the raw DB JSON string.
 */
export function preferAntigravityConnectionsWithStoredProject<T extends Record<string, unknown>>(
  connections: T[]
): T[] {
  if (!Array.isArray(connections) || connections.length === 0) return connections;
  const hasStoredProject = (connection: T): boolean => {
    if (typeof connection.projectId === "string" && connection.projectId.trim()) return true;
    let psd = connection.providerSpecificData;
    if (typeof psd === "string") {
      try {
        psd = JSON.parse(psd);
      } catch {
        return false;
      }
    }
    if (!psd || typeof psd !== "object") return false;
    const projectId = (psd as Record<string, unknown>).projectId;
    return typeof projectId === "string" && projectId.trim().length > 0;
  };
  const withStoredProject = connections.filter(hasStoredProject);
  return withStoredProject.length > 0 ? withStoredProject : connections;
}

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
