import test from "node:test";
import assert from "node:assert/strict";
import { createSSEStream } from "../../open-sse/utils/stream.ts";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.ts";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.ts";
import { isEmptyContentResponse } from "../../open-sse/services/errorClassifier.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { detectMalformedNonStream } from "../../open-sse/utils/diagnostics.ts";

const log = { warn() {} };
const headers = { "Content-Type": "text/event-stream" };
const encode = new TextEncoder();
const frame = (data: Record<string, unknown>) =>
  `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

function emptyTurn(reason: string | null, stop = true, emptyBlock = false): string {
  return [
    frame({
      type: "message_start",
      message: {
        id: "msg_native",
        role: "assistant",
        content: [],
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }),
    ...(emptyBlock
      ? [
          frame({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          frame({ type: "content_block_stop", index: 0 }),
        ]
      : []),
    frame({
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: reason === "stop_sequence" ? "END" : null },
      usage: { output_tokens: 3 },
    }),
    ...(stop ? [frame({ type: "message_stop" })] : []),
  ].join("");
}

function response(text: string, fragmented = false): Response {
  const bytes = encode.encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const size = fragmented ? 7 : bytes.length || 1;
        for (let offset = 0; offset < bytes.length; offset += size) {
          controller.enqueue(bytes.subarray(offset, offset + size));
        }
        controller.close();
      },
    }),
    { headers }
  );
}

function transform() {
  return createSSEStream({
    mode: "passthrough",
    sourceFormat: FORMATS.CLAUDE,
    clientResponseFormat: FORMATS.CLAUDE,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    body: { messages: [{ role: "user", content: "Say nothing if there is no suggestion" }] },
  });
}

for (const reason of ["end_turn", "stop_sequence"]) {
  test(`native Claude ${reason}: no reasoning required through transform, watcher and combo`, async () => {
    const expected = emptyTurn(reason);
    for (const fragmented of [false, true]) {
      for (const trailingNewline of [false, true]) {
        const upstream = response(trailingNewline ? expected : expected.trimEnd(), fragmented);
        const controller = createStreamController({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          clientResponseFormat: FORMATS.CLAUDE,
        });
        const watched = pipeWithDisconnect(upstream, transform(), controller);
        const quality = await validateResponseQuality(
          new Response(watched, { headers }),
          true,
          log,
          undefined,
          undefined,
          "anthropic"
        );
        assert.equal(quality.valid, true, quality.reason);
        const output = await quality.clonedResponse!.text();
        assert.equal(output, expected);
        assert.doesNotMatch(
          output,
          /content_block|signature_delta|reasoning_tokens|"type":"error"/
        );
      }
    }
  });

  test(`native Claude ${reason}: raw watcher and provider-independent combo accept the full lifecycle`, async () => {
    const text = emptyTurn(reason);
    const controller = createStreamController({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      clientResponseFormat: FORMATS.CLAUDE,
    });
    const watched = pipeWithDisconnect(response(text, true), new TransformStream(), controller);
    assert.equal(await new Response(watched).text(), text);
    const quality = await validateResponseQuality(response(text, true), true, log);
    assert.equal(quality.valid, true, quality.reason);
    assert.equal(await quality.clonedResponse!.text(), text);
  });
}

test("native Claude empty turns still reject invalid reasons, missing terminals and zero bytes", async () => {
  for (const text of [
    emptyTurn("content_filter"),
    emptyTurn(null),
    emptyTurn("max_tokens"),
    emptyTurn("tool_use"),
    emptyTurn("end_turn", false),
    emptyTurn("stop_sequence", false),
    "",
  ]) {
    await assert.rejects(
      new Response(response(text, true).body!.pipeThrough(transform())).text(),
      /empty response/
    );
    const quality = await validateResponseQuality(
      response(text, true),
      true,
      log,
      undefined,
      undefined,
      "anthropic"
    );
    assert.equal(quality.valid, false, text);
  }
});

test("native Claude watcher does not mistake message_delta, a bare stop header or a spoofed stop for completion", async () => {
  for (const reason of ["end_turn", "stop_sequence"]) {
    for (const suffix of [
      "",
      "event: message_stop\n\n",
      // SSE comment line carrying the terminal JSON is not an event.
      ': {"type":"message_stop"}\n\n',
      // A non-terminal payload that merely nests the terminal type.
      `event: ping\ndata: ${JSON.stringify({ type: "ping", note: { type: "message_stop" } })}\n\n`,
    ]) {
      const controller = createStreamController({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        clientResponseFormat: FORMATS.CLAUDE,
      });
      const watched = pipeWithDisconnect(
        response(emptyTurn(reason, false) + suffix, true),
        new TransformStream(),
        controller
      );
      assert.match(await new Response(watched).text(), /"type":"error"/);
    }
  }
});

test("native Claude clean stops do not hide upstream errors or empty text blocks", async () => {
  for (const reason of ["end_turn", "stop_sequence"]) {
    const errored =
      frame({
        type: "error",
        error: { type: "overloaded_error", message: "upstream overloaded" },
      }) + emptyTurn(reason);
    const quality = await validateResponseQuality(
      response(errored),
      true,
      log,
      undefined,
      undefined,
      "anthropic"
    );
    assert.equal(quality.valid, false);
    assert.match(quality.reason!, /upstream overloaded/);
    const emptyBlock = emptyTurn(reason, true, true);
    const blockQuality = await validateResponseQuality(
      response(emptyBlock),
      true,
      log,
      undefined,
      undefined,
      "anthropic"
    );
    assert.equal(blockQuality.valid, false);
    const controller = createStreamController({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      clientResponseFormat: FORMATS.CLAUDE,
    });
    const watched = pipeWithDisconnect(
      response(emptyBlock, true),
      new TransformStream(),
      controller
    );
    assert.match(await new Response(watched).text(), /"type":"error"/);
  }
});

test("native Claude non-streaming empty-response guards are unchanged", () => {
  for (const reason of ["end_turn", "stop_sequence"]) {
    const body = {
      type: "message",
      content: [],
      stop_reason: reason,
      usage: { input_tokens: 12, output_tokens: 3 },
    };
    assert.equal(isEmptyContentResponse(body, { provider: "anthropic" }), true);
    assert.equal(detectMalformedNonStream(body, "anthropic"), "empty_choices");
  }
});
