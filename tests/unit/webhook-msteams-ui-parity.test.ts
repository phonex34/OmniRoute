import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Locks two bugs found while merging the MS Teams webhook feature: WebhookCard.tsx
// carried its own stale local WebhookKind type (missing "msteams", diverged from
// src/lib/db/webhooks.ts's canonical union) with no icon/color entry for it, and
// EventChecklist.tsx still offered the two webhook events main removed as ghosts
// (#11050) — selecting either 400s the PUT /api/webhooks/[id] save.

const webhookCardSource = readFileSync(
  "src/app/(dashboard)/dashboard/webhooks/components/WebhookCard.tsx",
  "utf8"
);
const eventChecklistSource = readFileSync(
  "src/app/(dashboard)/dashboard/webhooks/components/shared/EventChecklist.tsx",
  "utf8"
);

test("WebhookCard's WebhookKind union includes msteams", () => {
  assert.match(
    webhookCardSource,
    /export type WebhookKind = "slack" \| "telegram" \| "discord" \| "msteams" \| "custom";/
  );
});

test("WebhookCard renders a dedicated icon and color for msteams", () => {
  const iconsBlock = webhookCardSource.match(/const KIND_ICONS[^}]+\}/)?.[0] ?? "";
  const colorsBlock = webhookCardSource.match(/const KIND_COLORS[^}]+\}/)?.[0] ?? "";
  assert.match(iconsBlock, /msteams: "groups"/, "KIND_ICONS must map msteams to an icon");
  assert.match(colorsBlock, /msteams: "text-indigo-500"/, "KIND_COLORS must map msteams to a color");
});

test("EventChecklist offers no ghost events (provider.error / provider.recovered)", () => {
  assert.doesNotMatch(
    eventChecklistSource,
    /provider\.error/,
    "provider.error was removed from WEBHOOK_EVENT_VALUES (#11050) — selecting it 400s the save"
  );
  assert.doesNotMatch(
    eventChecklistSource,
    /provider\.recovered/,
    "provider.recovered was removed from WEBHOOK_EVENT_VALUES (#11050) — selecting it 400s the save"
  );
});

test("EventChecklist's event list matches the live webhook event catalogue", () => {
  const listMatch = eventChecklistSource.match(/const WEBHOOK_EVENTS = \[([\s\S]*?)\] as const;/);
  assert.ok(listMatch, "WEBHOOK_EVENTS array must be present");
  const events = listMatch![1]
    .split(",")
    .map((s) => s.trim().replace(/"/g, ""))
    .filter(Boolean);
  assert.deepEqual(events, [
    "request.completed",
    "request.failed",
    "quota.exceeded",
    "usage.report",
    "combo.switched",
    "test.ping",
  ]);
});
