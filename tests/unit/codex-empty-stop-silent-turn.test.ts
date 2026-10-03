/**
 * #14160 follow-up — codex silent turn across every empty-content gate.
 *
 * A watchdog agent told "silence preferred" gets back, from codex, a turn with
 * content:null + finish_reason:"stop" and usage.reasoning_tokens > 0 (codex
 * reasoning is encrypted, so nothing visible is forwarded). #14243 only exempted
 * antigravity on the non-streaming leg; the stream watcher (#8649) and both
 * combo quality gates (#10404 stream, non-stream empty check) still rewrote the
 * turn into a 502, and a codex-only combo failed every target the same way.
 *
 * Codex is trusted only when reasoning tokens prove the model ran; an empty
 * shell without them, or from an untrusted provider, keeps failing over.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isEmptyContentResponse } from "../../open-sse/services/errorClassifier.ts";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.ts";
import {
  createDisconnectAwareStream,
  createStreamController,
} from "../../open-sse/utils/streamHandler.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

const silentLog = { warn: () => undefined };

const usage = (reasoning: number) => ({
  prompt_tokens: 27924,
  completion_tokens: reasoning + 6,
  total_tokens: 27924 + reasoning + 6,
  ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
});

/** Chat-completions stream exactly as the Responses→chat translator emits it. */
function silentChatStream(reasoning: number): string[] {
  const base = { id: "chatcmpl-x", object: "chat.completion.chunk", model: "gpt-6.1-sol" };
  return [
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: usage(reasoning) })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function sse(frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function silentJson(reasoning: number): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
      usage: usage(reasoning),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function clientSees(frames: string[], provider: string, format: string | null) {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  const sc = createStreamController({ provider, model: "m", clientResponseFormat: format });
  const stream = createDisconnectAwareStream(
    {
      readable: upstream.pipeThrough(new TransformStream()),
      writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
    },
    sc
  );
  return new Response(stream).text();
}

test("stream watcher: codex silent turn with reasoning closes clean", async () => {
  const text = await clientSees(silentChatStream(22), "codex", FORMATS.OPENAI);
  assert.doesNotMatch(text, /empty content|"finish_reason":\s*"error"/);
  assert.match(text, /\[DONE\]/);
});

test("stream watcher: codex Responses-format silent turn closes clean", async () => {
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_s",
      status: "completed",
      output: [{ id: "rs_1", type: "reasoning", encrypted_content: "gAAAAB" }],
      usage: {
        input_tokens: 10,
        output_tokens: 28,
        output_tokens_details: { reasoning_tokens: 22 },
      },
    },
  };
  const text = await clientSees(
    [`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`],
    "codex",
    FORMATS.OPENAI_RESPONSES
  );
  assert.doesNotMatch(text, /response\.failed|empty content/);
});

test("stream watcher: codex empty stop WITHOUT reasoning tokens still errors", async () => {
  const text = await clientSees(silentChatStream(0), "codex", FORMATS.OPENAI);
  assert.match(text, /empty content/i);
});

test("stream watcher: untrusted provider empty stop still errors", async () => {
  const text = await clientSees(silentChatStream(22), "opencode", FORMATS.OPENAI);
  assert.match(text, /empty content/i);
});

test("combo stream gate: codex silent turn is valid and replays the stream", async () => {
  const out = await validateResponseQuality(
    sse(silentChatStream(22)),
    true,
    silentLog,
    undefined,
    undefined,
    "codex"
  );
  assert.equal(out.valid, true, `got reason: ${out.reason}`);
  assert.ok(out.clonedResponse);
  assert.match(await out.clonedResponse.text(), /"finish_reason":"stop"/);
});

test("combo stream gate: same stream fails over without reasoning or trust", async () => {
  for (const [frames, provider] of [
    [silentChatStream(0), "codex"],
    [silentChatStream(22), "opencode"],
    [silentChatStream(22), undefined],
  ] as const) {
    const out = await validateResponseQuality(
      sse(frames),
      true,
      silentLog,
      undefined,
      undefined,
      provider
    );
    assert.equal(out.valid, false, `provider=${provider}`);
    assert.equal(out.reason, "streaming openai terminated with empty completion");
  }
});

test("combo non-stream gate: codex silent turn valid, untrusted/no-reasoning fail over", async () => {
  const ok = await validateResponseQuality(
    silentJson(22),
    false,
    silentLog,
    undefined,
    undefined,
    "codex"
  );
  assert.equal(ok.valid, true, `got reason: ${ok.reason}`);

  for (const [res, provider] of [
    [silentJson(0), "codex"],
    [silentJson(22), "opencode"],
  ] as const) {
    const out = await validateResponseQuality(
      res,
      false,
      silentLog,
      undefined,
      undefined,
      provider
    );
    assert.equal(out.valid, false, `provider=${provider}`);
    assert.match(out.reason ?? "", /empty content/);
  }
});

test("non-streaming leg classifier: codex needs reasoning tokens, antigravity does not", () => {
  const body = (reasoning: number) => ({
    choices: [{ message: { content: null }, finish_reason: "stop" }],
    usage: usage(reasoning),
  });
  assert.equal(isEmptyContentResponse(body(22), { provider: "codex" }), false);
  assert.equal(isEmptyContentResponse(body(0), { provider: "codex" }), true);
  assert.equal(isEmptyContentResponse(body(0), { provider: "antigravity" }), false);
  assert.equal(isEmptyContentResponse(body(22), { provider: "opencode" }), true);
});

test("stream watcher: response.status incomplete is not a trusted stop, even with completed items", async () => {
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_i",
      status: "incomplete",
      output: [{ id: "rs_1", type: "reasoning", status: "completed", encrypted_content: "gAAAAB" }],
      usage: { output_tokens: 28, output_tokens_details: { reasoning_tokens: 22 } },
    },
  };
  const text = await clientSees(
    [`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`],
    "codex",
    FORMATS.OPENAI_RESPONSES
  );
  assert.match(text, /response\.failed|empty content/);
});

test("stream watcher: real codex silent turn (empty final_answer message) closes clean", async () => {
  // Shape captured live from codex/gpt-6.1-sol on 2026-10-02: an encrypted
  // reasoning item plus an explicit final_answer message whose output_text is "".
  const message = {
    id: "msg_1",
    type: "message",
    status: "completed",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", annotations: [], logprobs: [], text: "" }],
  };
  const reasoningItem = {
    id: "rs_1",
    type: "reasoning",
    content: [],
    summary: [],
    encrypted_content: "gAAAAB",
  };
  const frame = (data: { type: string }) =>
    `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  const frames = [
    frame({ type: "response.output_item.done", output_index: 0, item: reasoningItem }),
    frame({ type: "response.output_text.done", output_index: 1, item_id: "msg_1", text: "" }),
    frame({ type: "response.output_item.done", output_index: 1, item: message }),
    frame({
      type: "response.completed",
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [reasoningItem, message],
        usage: {
          input_tokens: 27924,
          output_tokens: 18,
          output_tokens_details: { reasoning_tokens: 12 },
        },
      },
    }),
  ];
  const codex = await clientSees(frames, "codex", FORMATS.OPENAI_RESPONSES);
  assert.doesNotMatch(codex, /response\.failed|empty content/);
  const untrusted = await clientSees(frames, "opencode", FORMATS.OPENAI_RESPONSES);
  assert.match(untrusted, /response\.failed|empty content/);
});
