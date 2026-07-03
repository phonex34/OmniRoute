import { FORMATS } from "../../translator/formats.ts";
import { isClaudeCodeCompatibleProvider } from "../../services/claudeCodeCompatible.ts";
import { getHeaderValueCaseInsensitive } from "./headers.ts";
import { isClaudeSignatureReplaySafeForModel } from "../../utils/claudeThinkingSignature.ts";

export function shouldUseNativeCodexPassthrough({
  provider,
  sourceFormat,
  endpointPath,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  endpointPath?: string | null;
}): boolean {
  if (provider !== "codex") return false;
  if (sourceFormat !== FORMATS.OPENAI_RESPONSES) return false;
  let normalizedEndpoint = String(endpointPath || "");
  while (normalizedEndpoint.endsWith("/")) normalizedEndpoint = normalizedEndpoint.slice(0, -1);
  const segments = normalizedEndpoint.split("/");
  return segments.includes("responses");
}

/**
 * Pass `thinking` / `redacted_thinking` blocks through UNCHANGED.
 *
 * This used to rewrite every assistant thinking block to `redacted_thinking`
 * carrying a synthetic signature, on the assumption that a thinking signature is
 * bound to the auth token that produced it and would be rejected after a token /
 * model switch with 400 "Invalid signature in thinking block" (issue #2454).
 *
 * That rewrite is the actual cause of a different, far more common failure on the
 * Anthropic-native Claude OAuth passthrough:
 *
 *   400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
 *   latest assistant message cannot be modified. These blocks must remain as
 *   they were in the original response.
 *
 * The Messages API validates submitted thinking blocks against the original
 * response and rejects ANY modification — so converting them to
 * `redacted_thinking` makes every multi-turn request with thinking fail (most
 * visible on long Claude Code tool-loops). The thinking-block signature is
 * validated server-side by Anthropic and stays valid when the blocks are replayed,
 * including under a different OAuth token — verified by preserving the blocks
 * across a mid-conversation account switch with zero "Invalid signature"
 * responses. The redaction is therefore both unnecessary and the cause of the
 * regression, so the blocks are now returned verbatim. The `signature` parameter
 * is kept for call-site compatibility.
 */
export function redactPassthroughThinkingSignatures(
  messages: unknown,
  _signature: string
): unknown {
  return messages;
}

/**
 * Sanitize replayed `thinking` blocks on the Anthropic-native Claude OAuth passthrough
 * using CLIProxyAPI's validate-then-preserve-or-drop strategy (internal/signature):
 * KEEP a thinking block when its signature is safe to replay to the target model,
 * DROP it otherwise. Blocks are never rewritten in place.
 *
 * Three 400s occur when prior assistant thinking blocks are replayed as history:
 *
 *   1. messages.N.content.M.thinking: each thinking block must contain thinking
 *      — Anthropic can emit a `thinking` block with empty visible text plus a valid
 *        signature (#5108, the non-streaming Bash classifier).
 *   2. messages.N.content.M: Invalid `signature` in `thinking` block
 *      — a thinking signature is bound to the exact model that minted it; a combo that
 *        hops claude-opus → claude-sonnet replays an opus signature to a sonnet target,
 *        which Anthropic rejects (#2454).
 *   3. Rewriting the block in place instead (a previous fix) trips "blocks in the latest
 *      assistant message cannot be modified" (#3775).
 *
 * Anthropic forbids *modifying* thinking blocks in the latest assistant turn but ALLOWS
 * *dropping* them, and Claude has no cross-provider bypass sentinel, so an unsafe block
 * is dropped rather than rewritten. A block is kept only when
 * `isClaudeSignatureReplaySafeForModel` confirms its signature is a structurally-valid
 * Claude signature AND either carries no model tag (compact schema) or a model tag that
 * matches `targetModel`. This preserves the reasoning chain on same-model multi-turn
 * (the common case) and drops only the blocks that would actually 400 — the cross-model
 * combo hop and the empty/foreign/fabricated ones.
 *
 * Applied uniformly to every assistant turn (dropping is not a modification). Messages
 * emptied by the drop are removed so no empty `content: []` reaches Anthropic. Returns
 * the same array reference when nothing needed dropping.
 */
export function sanitizeClaudePassthroughThinkingBlocks(
  messages: unknown,
  targetModel: string | null | undefined
): unknown {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  let mutated = false;
  const out: unknown[] = [];

  for (const msg of messages) {
    const m = msg as { role?: unknown; content?: unknown } | null;
    if (!m || typeof m !== "object" || m.role !== "assistant" || !Array.isArray(m.content)) {
      out.push(msg);
      continue;
    }

    const blocks = m.content as Array<Record<string, unknown>>;
    let contentMutated = false;
    const kept = blocks.filter((block) => {
      if (!block || typeof block !== "object") return true;
      if (block.type === "thinking") {
        if (isClaudeSignatureReplaySafeForModel(block.signature, targetModel)) return true;
        contentMutated = true;
        return false;
      }
      if (block.type === "redacted_thinking") {
        // redacted_thinking carries an opaque `data` blob (no inspectable model tag);
        // its replay safety cannot be verified, so drop it on cross-model-capable combos.
        contentMutated = true;
        return false;
      }
      return true;
    });

    if (!contentMutated) {
      out.push(msg);
      continue;
    }

    mutated = true;
    if (kept.length === 0) continue;
    out.push({ ...m, content: kept });
  }

  return mutated ? out : messages;
}

export function isClaudeCodeSemanticPassthroughRequest({
  provider,
  sourceFormat,
  targetFormat,
  headers,
  userAgent,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  targetFormat?: string | null;
  headers?: Record<string, unknown> | Headers | null;
  userAgent?: string | null;
}): boolean {
  const isDirectClaudeCodeProvider =
    provider === "claude" || isClaudeCodeCompatibleProvider(provider);
  if (!isDirectClaudeCodeProvider) return false;
  if (sourceFormat !== FORMATS.CLAUDE) return false;
  if (targetFormat !== FORMATS.CLAUDE) return false;

  const headerUserAgent = getHeaderValueCaseInsensitive(headers, "user-agent");
  const ua = `${userAgent || ""} ${headerUserAgent || ""}`.toLowerCase();
  if (ua.includes("claude-code") || ua.includes("claude-cli")) return true;

  const appHeader = getHeaderValueCaseInsensitive(headers, "x-app");
  if (typeof appHeader === "string" && appHeader.trim().toLowerCase() === "cli") return true;

  const sessionId = getHeaderValueCaseInsensitive(headers, "x-claude-code-session-id");
  return typeof sessionId === "string" && sessionId.trim().length > 0;
}
