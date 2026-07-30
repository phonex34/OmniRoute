/**
 * Shared ReactFlow edge palette + styling, extracted verbatim from
 * `ProviderTopology.tsx` (U0). Reused by the Combo/Routing Studio (Tela B) and
 * the Compression Studio (Tela A) so all three flow graphs speak the same
 * color language: green = active, red = error, amber = last-used, muted = idle.
 */
import { STATUS_HEX } from "@/shared/constants/statusColors";

export const FLOW_EDGE_COLORS = {
  active: STATUS_HEX.success,
  error: STATUS_HEX.error,
  last: STATUS_HEX.warning,
  // Connected-at-rest: the same success green as `active`, but the edge is intentionally
  // thin + low-opacity (see edgeStyle) so it recedes. Health is told apart from live traffic
  // by weight/animation (calm static line vs. thick animated pulse), not by hue.
  healthy: STATUS_HEX.success,
  idle: "var(--color-text-muted)",
} as const;

export interface FlowEdgeStyle {
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

/**
 * Resolve the stroke style for an edge given its state. Precedence is
 * error > active > last-used > healthy > idle — the first three are identical to the
 * original ProviderTopology implementation (do not reorder without updating the home
 * regression). `healthy` is the connection-health base state (a configured provider with
 * a live/healthy connection but no in-flight traffic): a thin, low-opacity green stroke that
 * makes the map meaningful at rest, distinct from (and quieter than) the thick, fully-opaque
 * animated `active` green. It is an optional trailing param so existing callers
 * (Combo/Compression studios) stay unaffected.
 */
export function edgeStyle(
  active: boolean,
  last: boolean,
  error: boolean,
  healthy = false
): FlowEdgeStyle {
  if (error) return { stroke: FLOW_EDGE_COLORS.error, strokeWidth: 2, opacity: 0.85 };
  if (active) return { stroke: FLOW_EDGE_COLORS.active, strokeWidth: 2.5, opacity: 1 };
  if (last) return { stroke: FLOW_EDGE_COLORS.last, strokeWidth: 1.5, opacity: 0.6 };
  if (healthy) return { stroke: FLOW_EDGE_COLORS.healthy, strokeWidth: 1.25, opacity: 0.4 };
  return { stroke: FLOW_EDGE_COLORS.idle, strokeWidth: 1, opacity: 0.3 };
}
