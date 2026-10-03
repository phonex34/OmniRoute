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
import { detectMalformedNonStream } from "../../open-sse/utils/diagnostics.ts";
import { createSSEStream } from "../../open-sse/utils/stream.ts";

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

test("non-streaming leg classifier: clean stops need Codex reasoning or antigravity trust", () => {
  for (const reason of ["stop", "end_turn", "stop_sequence"]) {
    const body = (reasoning: number) => ({
      choices: [{ message: { content: null }, finish_reason: reason }],
      usage: usage(reasoning),
    });
    assert.equal(isEmptyContentResponse(body(22), { provider: "codex" }), false, reason);
    assert.equal(isEmptyContentResponse(body(0), { provider: "codex" }), true, reason);
    assert.equal(isEmptyContentResponse(body(0), { provider: "antigravity" }), false, reason);
    assert.equal(isEmptyContentResponse(body(22), { provider: "opencode" }), true, reason);
  }
  for (const reason of ["end_turn", "stop_sequence"]) {
    const body = (reasoning: number) => ({
      content: [],
      stop_reason: reason,
      usage: usage(reasoning),
    });
    assert.equal(isEmptyContentResponse(body(22), { provider: "codex" }), false, reason);
    assert.equal(isEmptyContentResponse(body(0), { provider: "codex" }), true, reason);
    assert.equal(isEmptyContentResponse(body(0), { provider: "antigravity" }), false, reason);
    assert.equal(isEmptyContentResponse(body(22), { provider: "opencode" }), true, reason);
  }
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
  const frame = <T extends { type: string }>(data: T) =>
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

test("chatCore malformed detector: codex silent turn is not empty_choices", () => {
  const body = (reasoning: number) => ({
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }],
    usage: usage(reasoning),
  });
  assert.equal(detectMalformedNonStream(body(22), "codex"), null);
  assert.equal(detectMalformedNonStream(body(0), "codex"), "empty_choices");
  assert.equal(detectMalformedNonStream(body(22), "opencode"), "empty_choices");
  assert.equal(detectMalformedNonStream(body(22)), "empty_choices");
});

test("Claude client (/v1/messages) on codex: silent turn survives translation, watcher and combo", async () => {
  // Shape seen live 2026-10-05 on pool-main-sol: Claude Code → codex Responses,
  // reasoning-only turn, translated to Claude SSE with no content block.
  const reasoningItem = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "gAAAAB" };
  const sse = <T extends { type: string }>(data: T) =>
    `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  const frames = (reasoning: number) => [
    sse({
      type: "response.created",
      response: { id: "resp_c", status: "in_progress", output: [] },
    }),
    sse({ type: "response.output_item.done", output_index: 0, item: reasoningItem }),
    sse({
      type: "response.completed",
      response: {
        id: "resp_c",
        status: "completed",
        output: [reasoningItem],
        usage: {
          input_tokens: 1000,
          output_tokens: reasoning + 6,
          output_tokens_details: { reasoning_tokens: reasoning },
        },
      },
    }),
  ];
  const run = (
    provider: string,
    reasoning: number,
    terminal = "response.completed",
    split = false
  ) => {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames(reasoning)) {
          if (f.includes('"type":"response.completed"')) {
            if (terminal === "missing") continue;
            if (terminal === "response.failed") {
              c.enqueue(
                enc.encode(
                  sse({
                    type: terminal,
                    response: { status: "failed", error: { message: "upstream failed" } },
                  })
                )
              );
              continue;
            }
          }
          const bytes = enc.encode(f);
          if (split) {
            const middle = Math.floor(bytes.length / 2);
            c.enqueue(bytes.subarray(0, middle));
            c.enqueue(bytes.subarray(middle));
          } else {
            c.enqueue(bytes);
          }
        }
        c.close();
      },
    });
    const stream = createSSEStream({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.CLAUDE,
      provider,
      model: "gpt-6.1-sol",
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const controller = createStreamController({
      provider,
      model: "gpt-6.1-sol",
      clientResponseFormat: FORMATS.CLAUDE,
    });
    const watched = createDisconnectAwareStream(
      {
        readable: source.pipeThrough(stream),
        writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
      },
      controller
    );
    return new Response(watched).text().catch((e: Error) => `THREW ${e.message}`);
  };

  const codex = await run("codex", 22);
  assert.doesNotMatch(codex, /empty response|THREW/);
  assert.doesNotMatch(codex, /content_block_start|signature_delta/);
  assert.match(codex, /message_stop/);
  assert.match(codex, /"reasoning_tokens":22/);
  const quality = await validateResponseQuality(
    new Response(codex, { headers: { "Content-Type": "text/event-stream" } }),
    true,
    silentLog,
    undefined,
    undefined,
    "codex"
  );
  assert.equal(quality.valid, true, quality.reason);
  assert.equal(await quality.clonedResponse?.text(), codex);
  assert.match(codex, /"output_tokens":28/);
  const fragmented = await run("codex", 22, "response.completed", true);
  assert.match(fragmented, /"reasoning_tokens":22/);
  assert.match(fragmented, /message_stop/);
  assert.doesNotMatch(fragmented, /"type":"error"|THREW/);
  for (const terminal of ["missing", "response.failed"]) {
    const out = await run("codex", 22, terminal);
    const rejected = await validateResponseQuality(
      new Response(out, { headers: { "Content-Type": "text/event-stream" } }),
      true,
      silentLog,
      undefined,
      undefined,
      "codex"
    );
    assert.equal(rejected.valid, false, terminal);
  }

  for (const [provider, reasoning] of [
    ["codex", 0],
    ["opencode", 22],
  ] as const) {
    const out = await run(provider, reasoning);
    assert.match(out, /Claude returned an empty response|THREW/, `${provider}/${reasoning}`);
  }
});

test("Claude translation trusts clean upstream finishes but not lossy end_turn projections", async () => {
  for (const finish of [
    "stop",
    "end_turn",
    "stop_sequence",
    "content_filter",
    "future_unknown_reason",
  ]) {
    const payload = {
      id: "chat_x",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: usage(22),
    };
    const upstream = new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    const translated = upstream.body!.pipeThrough(
      createSSEStream({
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.CLAUDE,
        provider: "codex",
        model: "gpt-6.1-sol",
        body: { messages: [{ role: "user", content: "hi" }] },
      })
    );
    if (["stop", "end_turn", "stop_sequence"].includes(finish)) {
      const text = await new Response(translated).text();
      assert.match(text, /message_stop/);
      assert.doesNotMatch(text, /"type":"error"/);
    } else {
      await assert.rejects(new Response(translated).text(), /empty response/);
    }
  }
});

test("Claude combo silent stop requires actual message_stop and reasoning evidence", async () => {
  const frame = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
  for (const [provider, reason, reasoning, stop, expected] of [
    ["codex", "end_turn", 22, true, true],
    ["codex", "stop_sequence", 22, true, true],
    ["antigravity", "end_turn", 0, true, true],
    ["antigravity", "stop_sequence", 0, true, true],
    ["codex", "end_turn", 0, true, false],
    ["codex", "stop_sequence", 0, true, false],
    ["opencode", "end_turn", 22, true, false],
    ["opencode", "stop_sequence", 22, true, false],
    ["codex", "content_filter", 22, true, false],
    ["codex", null, 22, true, false],
    ["codex", "end_turn", 22, false, false],
    ["codex", "stop_sequence", 22, false, false],
  ] as const) {
    const text = [
      frame({ type: "message_start", message: { content: [] } }),
      frame({
        type: "message_delta",
        delta: { stop_reason: reason },
        usage: { output_tokens: 28, output_tokens_details: { reasoning_tokens: reasoning } },
      }),
      ...(stop ? [frame({ type: "message_stop" })] : []),
    ].join("");
    const response = new Response(text, {
      headers: { "Content-Type": "text/event-stream" },
    });
    const verdict = await validateResponseQuality(
      response,
      true,
      silentLog,
      undefined,
      undefined,
      provider
    );
    assert.equal(
      verdict.valid,
      expected,
      `${provider}/${reason}/${reasoning}/message_stop=${stop}`
    );
    if (expected) {
      assert.equal(await verdict.clonedResponse?.text(), text);
    }
  }
});

test("Claude passthrough: end_turn and stop_sequence survive transform, watcher and combo", async () => {
  for (const [provider, reasoning] of [
    ["codex", 22],
    ["antigravity", 0],
  ] as const) {
    for (const reason of ["end_turn", "stop_sequence"]) {
      const frame = <T extends { type: string }>(data: T) =>
        `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
      const frames = [
        frame({
          type: "message_start",
          message: { id: "msg_silent", role: "assistant", content: [] },
        }),
        frame({
          type: "message_delta",
          delta: { stop_reason: reason, stop_sequence: reason === "stop_sequence" ? "END" : null },
          usage: { output_tokens: 28, output_tokens_details: { reasoning_tokens: reasoning } },
        }),
        frame({ type: "message_stop" }),
      ];
      for (const trailingNewline of [true, false]) {
        const source = sse([trailingNewline ? frames.join("") : frames.join("").trimEnd()]);
        const transformed = source.body!.pipeThrough(
          createSSEStream({
            mode: "passthrough",
            sourceFormat: FORMATS.CLAUDE,
            clientResponseFormat: FORMATS.CLAUDE,
            provider,
            model: "m",
            body: { messages: [{ role: "user", content: "hi" }] },
          })
        );
        const text = await new Response(transformed).text();
        assert.equal(text, frames.join(""), `${provider}/${reason}: no synthetic content`);
        assert.equal(await clientSees([text], provider, FORMATS.CLAUDE), text);
        const quality = await validateResponseQuality(
          sse([text]),
          true,
          silentLog,
          undefined,
          undefined,
          provider
        );
        assert.equal(quality.valid, true, `${provider}/${reason}: ${quality.reason}`);
        assert.equal(await quality.clonedResponse?.text(), text);
      }
    }
  }
});

test("Claude passthrough rejects untrusted, unfinished and zero-byte silent turns", async () => {
  for (const [provider, reason, reasoning, stop] of [
    ["codex", "end_turn", 0, true],
    ["codex", "stop_sequence", 0, true],
    ["opencode", "end_turn", 22, true],
    ["opencode", "stop_sequence", 22, true],
    ["codex", "content_filter", 22, true],
    ["codex", null, 22, true],
    ["codex", "end_turn", 22, false],
    ["codex", "stop_sequence", 22, false],
    ["codex", "zero_bytes", 22, false],
  ] as const) {
    const frame = <T extends { type: string }>(data: T) =>
      `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
    const frames =
      reason === "zero_bytes"
        ? []
        : [
            frame({ type: "message_start", message: { content: [] } }),
            frame({
              type: "message_delta",
              delta: { stop_reason: reason },
              usage: { output_tokens: 28, output_tokens_details: { reasoning_tokens: reasoning } },
            }),
            ...(stop ? [frame({ type: "message_stop" })] : []),
          ];
    const transformed = sse(frames).body!.pipeThrough(
      createSSEStream({
        mode: "passthrough",
        sourceFormat: FORMATS.CLAUDE,
        clientResponseFormat: FORMATS.CLAUDE,
        provider,
        model: "m",
        body: { messages: [{ role: "user", content: "hi" }] },
      })
    );
    await assert.rejects(
      new Response(transformed).text(),
      /empty response/,
      `${provider}/${reason}/${reasoning}/message_stop=${stop}`
    );
  }
});
