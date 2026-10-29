/**
 * An authenticated native Codex turn that completes normally with no visible output
 * (e.g. a watchdog agent choosing silence) is a successful Claude `end_turn`.
 * The client receives a 200 and decides whether to continue; the combo must not
 * retry or fail over. Unauthenticated or failed completions still fail over.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pipeWithDisconnect, createStreamController } from "../../open-sse/utils/streamHandler.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { createSSEStream } from "../../open-sse/utils/stream.ts";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.ts";
import {
  hasTrustedEmptyTurn,
  markEmptyTurnExecution,
} from "../../open-sse/utils/emptyTurnPolicy.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";

const frame = (event: Record<string, unknown>) =>
  `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "enc" };

function reasoningOnlyTurn(status: "completed" | "failed"): string {
  return [
    frame({ type: "response.created", response: { id: "r", status: "in_progress", output: [] } }),
    frame({ type: "response.output_item.added", output_index: 0, item: reasoning }),
    frame({ type: "response.output_item.done", output_index: 0, item: reasoning }),
    frame({
      type: status === "failed" ? "response.failed" : "response.completed",
      response: {
        id: "r",
        object: "response",
        status,
        error: status === "failed" ? { message: "upstream failed" } : null,
        output: [reasoning],
        usage: {
          input_tokens: 99,
          output_tokens: 24,
          output_tokens_details: { reasoning_tokens: 18 },
        },
      },
    }),
  ].join("");
}

async function claudeClientTurn(status: "completed" | "failed", authenticated: boolean) {
  const raw = new Response(reasoningOnlyTurn(status), {
    headers: { "Content-Type": "text/event-stream" },
  });
  const upstream = authenticated
    ? markEmptyTurnExecution(raw, getRegistryEntry("codex")!.baseUrl!, {
        connectionId: "codex-conn",
        accessToken: "codex-token",
      })
    : raw;
  const watched = pipeWithDisconnect(
    upstream,
    createSSEStream({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.CLAUDE,
      provider: "codex",
      trustedEmptyTurn: () => hasTrustedEmptyTurn(upstream),
      model: "gpt-6.1-sol",
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
    createStreamController({ provider: "codex", model: "m", clientResponseFormat: FORMATS.CLAUDE })
  );
  const text = await new Response(watched).text().catch((error: Error) => `THREW ${error.message}`);
  const quality = await validateResponseQuality(
    new Response(text, { headers: { "Content-Type": "text/event-stream" } }),
    true,
    { warn: () => undefined },
    undefined,
    undefined,
    () => hasTrustedEmptyTurn(upstream),
    false,
    "codex"
  );
  return { text, quality };
}

test("authenticated Codex silent turn reaches a Claude client as a clean 200 end_turn", async () => {
  const { text, quality } = await claudeClientTurn("completed", true);
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.doesNotMatch(text, /event: error/);
  assert.equal(quality.valid, true, quality.reason);
});

test("unauthenticated Codex silent turn still fails over", async () => {
  const { quality } = await claudeClientTurn("completed", false);
  assert.equal(quality.valid, false);
});

test("failed Codex completion never becomes a silent success", async () => {
  const { quality } = await claudeClientTurn("failed", true);
  assert.equal(quality.valid, false);
});
