export type WebhookEvent =
  | "request.completed"
  | "request.failed"
  | "provider.error"
  | "provider.recovered"
  | "quota.exceeded"
  | "usage.report"
  | "combo.switched"
  | "test.ping";

export interface EventDescription {
  label: string;
  description: string;
  emoji: string;
  exampleData: Record<string, unknown>;
}

export const EVENT_DESCRIPTIONS: Record<WebhookEvent, EventDescription> = {
  "request.completed": {
    label: "Request Completed",
    emoji: "✅",
    description: "Triggered when an upstream request completes successfully (HTTP 2xx).",
    exampleData: {
      model: "claude-opus-4-7",
      provider: "claude",
      latencyMs: 1240,
      tokensIn: 142,
      tokensOut: 38,
    },
  },
  "request.failed": {
    label: "Request Failed",
    emoji: "🚨",
    description: "Triggered when a request fails after all retries and fallback combo targets.",
    exampleData: {
      model: "claude-opus-4-7",
      provider: "claude",
      error: "503 Service Unavailable",
      attempts: 3,
    },
  },
  "provider.error": {
    label: "Provider Error",
    emoji: "⚠️",
    description: "A provider tripped the circuit breaker due to repeated failures.",
    exampleData: { provider: "openai", model: "gpt-4o", errorCode: 503, consecutiveFailures: 3 },
  },
  "provider.recovered": {
    label: "Provider Recovered",
    emoji: "✅",
    description: "A provider recovered from a circuit-breaker OPEN state.",
    exampleData: { provider: "openai", recoveredAfterMs: 60000 },
  },
  "quota.exceeded": {
    label: "Quota Exceeded",
    emoji: "📊",
    description: "A usage threshold (e.g. 95% of quota) was reached.",
    exampleData: { quota: "daily_tokens", used: 950000, limit: 1000000, pct: 95 },
  },
  "usage.report": {
    label: "Usage Report",
    emoji: "📈",
    description:
      "Periodic OAuth quota summary, emitted by the background provider-limits sync (~every 70 min).",
    exampleData: {
      intervalMinutes: 70,
      accountCount: 2,
      accounts: [
        {
          provider: "codex",
          account: "me@example.com",
          worstRemainingPct: 18,
          windows: [
            {
              name: "weekly",
              displayName: "Weekly",
              remainingPct: 18,
              resetAt: "2026-05-21T00:00:00Z",
              unlimited: false,
            },
            {
              name: "session",
              displayName: "Session",
              remainingPct: 74,
              resetAt: "2026-05-14T20:00:00Z",
              unlimited: false,
            },
          ],
        },
        {
          provider: "claude",
          account: "team@example.com",
          worstRemainingPct: 88,
          windows: [
            { name: "session", displayName: "Session", remainingPct: 88, unlimited: false },
          ],
        },
      ],
    },
  },
  "combo.switched": {
    label: "Combo Switched",
    emoji: "🔄",
    description:
      "A combo dropped off its premium front tier (e.g. Codex/Claude exhausted) and is now served by a lower tier. Sent once per drop, re-armed when the premium tier recovers.",
    exampleData: {
      combo: "always-on",
      fromProvider: "codex",
      fromTier: "premium",
      toProvider: "glm",
      toModel: "glm/glm-5.1",
      toTier: "cheap",
      fallbackCount: 2,
      reason: "front-tier-exhausted",
    },
  },
  "test.ping": {
    label: "Test Ping",
    emoji: "🏓",
    description: "Manual test delivery to verify your webhook is reachable.",
    exampleData: { message: "Test ping from OmniRoute", webhookId: "preview" },
  },
};
