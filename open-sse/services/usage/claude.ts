/**
 * usage/claude.ts — Claude (Anthropic OAuth + legacy org) usage fetcher + plan-label helper.
 *
 * Extracted from services/usage.ts (god-file decomposition): the Claude family — the API
 * config, the plan-label picker, the OAuth usage fetcher (getClaudeUsage) with its legacy
 * settings/org fallback (getClaudeUsageLegacy). Depends only on the sibling scalar/quota
 * leaves + Claude identity/cooldown helpers + safePercentage — no host coupling — so it
 * lives as a co-located provider leaf. usage.ts imports getClaudeUsage (dispatcher) +
 * getClaudePlanLabel (__testing). Behavior-preserving move.
 */

import { safePercentage } from "@/shared/utils/formatting";
import { CLAUDE_CODE_VERSION, fetchClaudeBootstrap } from "../../executors/claudeIdentity.ts";
import {
  isClaudeOauthUsageCoolingDown,
  markClaudeOauthUsage429,
  isClaudeUsageFetchTooSoon,
  markClaudeUsageFetchAttempt,
} from "../claudeUsageCooldown.ts";
import { toRecord } from "./scalars.ts";
import { type UsageQuota, parseResetTime } from "./quota.ts";

type JsonRecord = Record<string, unknown>;

// Claude API config
const CLAUDE_CONFIG = {
  oauthUsageUrl: "https://api.anthropic.com/api/oauth/usage",
  usageUrl: "https://api.anthropic.com/v1/organizations/{org_id}/usage",
  settingsUrl: "https://api.anthropic.com/v1/settings",
  apiVersion: "2023-06-01",
};

export function getClaudePlanLabel(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (
      !trimmed ||
      trimmed.toLowerCase() === "claude code" ||
      trimmed.toLowerCase() === "unknown"
    ) {
      continue;
    }
    return trimmed;
  }
  return null;
}

/**
 * Claude Usage - Try to fetch from Anthropic API
 */
export async function getClaudeUsage(accessToken?: string) {
  if (!accessToken) {
    return { message: "Claude connected. Access token not available.", bootstrap: null };
  }

  // Refresh bootstrap in parallel; best-effort, failure non-fatal.
  const bootstrapPromise = fetchClaudeBootstrap(accessToken).catch(() => null);
  // Skip OAuth usage call while this token is cooling down from a recent 429,
  // or when the previous poll was too recent (proactive min-interval gate). Chat
  // with the same token still works — only the quota endpoint is throttled.
  if (isClaudeOauthUsageCoolingDown(accessToken) || isClaudeUsageFetchTooSoon(accessToken)) {
    const legacy = await getClaudeUsageLegacy(accessToken);
    return { ...legacy, bootstrap: await bootstrapPromise };
  }
  markClaudeUsageFetchAttempt(accessToken);
  try {
    // Real CLI uses axios here, not Stainless — UA is `claude-code/<version>`
    // (not `claude-cli/...`) and the shape is simpler than /v1/messages.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let oauthResponse;
    try {
      oauthResponse = await fetch(CLAUDE_CONFIG.oauthUsageUrl, {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Encoding": "gzip, compress, deflate, br",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": `claude-code/${CLAUDE_CODE_VERSION}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (oauthResponse.ok) {
      const data = toRecord(await oauthResponse.json());
      const quotas: Record<string, UsageQuota> = {};

      // utilization = percentage USED (e.g., 90 means 90% used, 10% remaining)
      // Confirmed via user report #299: Claude.ai shows 87% used = OmniRoute must show 13% remaining.
      const hasUtilization = (window: JsonRecord) =>
        window && typeof window === "object" && safePercentage(window.utilization) !== undefined;

      const buildPercentageQuota = (usedPercent: number, resetValue: unknown): UsageQuota => {
        const used = Math.min(Math.max(0, usedPercent), 100);
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          resetAt: parseResetTime(resetValue),
          remainingPercentage: remaining,
          unlimited: false,
        };
      };

      const createQuotaObject = (window: JsonRecord) =>
        buildPercentageQuota(safePercentage(window.utilization) as number, window.resets_at);

      // Map Anthropic's internal codenames (e.g., omelette → Designer) for display.
      const MODEL_DISPLAY_NAMES: Record<string, string> = {
        omelette: "designer",
      };

      // ── New format (Anthropic changed /api/oauth/usage ~2026-07-02) ──────────
      // The flat `seven_day_<model>` fields are now null on current accounts; the
      // per-model weekly buckets (Fable, Opus, Sonnet, …) live ONLY in a generic
      // `limits[]` array. Each entry is self-describing:
      //   { kind: "session" | "weekly_all" | "weekly_scoped",
      //     percent: <0–100 % used>, resets_at: <ISO>,
      //     scope?: { model?: { display_name?: string } },   // e.g. "Fable"
      //     is_active?: boolean }
      // We surface every entry that carries a numeric percent. `is_active` is NOT
      // a visibility flag — Anthropic marks non-binding windows `is_active:false`
      // while still populating a real percentage, and Claude's own /usage UI
      // renders them (verified against a live Max-20x payload: weekly_all=20% and
      // weekly_scoped Fable=28% both arrive with is_active:false yet are shown).
      // Skipping them dropped the Fable bar entirely, so we key off `percent`.
      const limits = Array.isArray(data.limits) ? data.limits : [];
      for (const entry of limits) {
        const record = toRecord(entry);
        const rawPercent = record.percent ?? record.utilization;
        const usedPercent = safePercentage(rawPercent);
        if (usedPercent === undefined) continue;

        const kind = typeof record.kind === "string" ? record.kind : "";
        if (kind === "session") {
          quotas["session (5h)"] = buildPercentageQuota(usedPercent, record.resets_at);
        } else if (kind === "weekly_all") {
          quotas["weekly (7d)"] = buildPercentageQuota(usedPercent, record.resets_at);
        } else if (kind === "weekly_scoped") {
          const scope = toRecord(record.scope);
          const model = toRecord(scope.model);
          const displayName =
            typeof model.display_name === "string" ? model.display_name.trim() : "";
          if (!displayName) continue;
          const codename = displayName.toLowerCase();
          const modelName = MODEL_DISPLAY_NAMES[codename] || codename;
          quotas[`weekly ${modelName} (7d)`] = buildPercentageQuota(usedPercent, record.resets_at);
        }
      }

      // ── Legacy flat fields (older account cohorts) ──────────────────────────
      // Only backfill windows the new `limits[]` array didn't already populate, so
      // a mixed payload never overwrites authoritative new-format data.
      const fiveHour = toRecord(data.five_hour);
      if (!quotas["session (5h)"] && hasUtilization(fiveHour)) {
        quotas["session (5h)"] = createQuotaObject(fiveHour);
      }

      const sevenDay = toRecord(data.seven_day);
      if (!quotas["weekly (7d)"] && hasUtilization(sevenDay)) {
        quotas["weekly (7d)"] = createQuotaObject(sevenDay);
      }

      for (const [key, value] of Object.entries(data)) {
        const valueRecord = toRecord(value);
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(valueRecord)) {
          const codename = key.replace("seven_day_", "");
          const modelName = MODEL_DISPLAY_NAMES[codename] || codename;
          const quotaKey = `weekly ${modelName} (7d)`;
          if (!quotas[quotaKey]) {
            quotas[quotaKey] = createQuotaObject(valueRecord);
          }
        }
      }

      const bootstrap = await bootstrapPromise;
      const plan =
        getClaudePlanLabel(
          typeof data.tier === "string" ? data.tier : null,
          typeof data.plan === "string" ? data.plan : null,
          typeof data.subscription_type === "string" ? data.subscription_type : null,
          bootstrap?.organization_rate_limit_tier
        ) ?? undefined;

      return {
        ...(plan ? { plan } : {}),
        quotas,
        extraUsage: data.extra_usage ?? null,
        bootstrap,
      };
    }

    // Cool down OAuth usage polling after a 429 (quota endpoint only — chat is unaffected).
    if (oauthResponse.status === 429) {
      markClaudeOauthUsage429(accessToken);
    }

    // Fallback: OAuth endpoint returned non-OK, try legacy settings/org endpoint
    console.warn(
      `[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`
    );
    const legacy = await getClaudeUsageLegacy(accessToken);
    return { ...legacy, bootstrap: await bootstrapPromise };
  } catch (error) {
    return {
      message: `Claude connected. Unable to fetch usage: ${(error as Error).message}`,
      bootstrap: await bootstrapPromise,
    };
  }
}

/**
 * Legacy Claude usage fetcher for API key / org admin users.
 * Uses /v1/settings + /v1/organizations/{org_id}/usage endpoints.
 */
async function getClaudeUsageLegacy(accessToken?: string) {
  try {
    const settingsResponse = await fetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    });

    if (settingsResponse.ok) {
      const settings = toRecord(await settingsResponse.json());

      const organizationId =
        typeof settings.organization_id === "string" ? settings.organization_id : "";
      if (organizationId) {
        const usageResponse = await fetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", organizationId),
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          }
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${(error as Error).message}` };
  }
}
