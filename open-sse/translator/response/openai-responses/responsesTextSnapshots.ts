import { appendBoundedText } from "../../../utils/streamHelpers.ts";

type EmittedPart = { text: string; ambiguous: boolean; pendingRefusal?: string };
type MessageRecord = {
  id?: string;
  index?: number;
  commentary: boolean;
  parts: Map<string, EmittedPart>;
};
type TextTracker = {
  ids: Map<string, MessageRecord>;
  indexes: Map<number, MessageRecord>;
  records: Set<MessageRecord>;
};

function trackerFor(state): TextTracker {
  if (!state.responsesTextTracker) {
    state.responsesTextTracker = {
      ids: new Map(),
      indexes: new Map(),
      records: new Set(),
    };
  }
  return state.responsesTextTracker;
}

// Events may alternate item_id and output_index. Bind both aliases as soon as
// either appears. An identity-free stream can only be matched to one message;
// never guess which of several messages an anonymous fragment belongs to.
function messageRecord(state, data, allowAnonymousMatch = true): MessageRecord | null {
  const tracker = trackerFor(state);
  const id =
    typeof (data.item_id ?? data.item?.id) === "string"
      ? (data.item_id ?? data.item.id)
      : undefined;
  const index =
    Number.isInteger(data.output_index) && data.output_index >= 0 ? data.output_index : undefined;
  let record = id !== undefined ? tracker.ids.get(id) : undefined;
  const byIndex = index !== undefined ? tracker.indexes.get(index) : undefined;
  if (
    record &&
    byIndex &&
    record !== byIndex &&
    (record.id === undefined || byIndex.id === undefined || record.id === byIndex.id)
  ) {
    for (const [key, part] of byIndex.parts) {
      const existing = record.parts.get(key);
      if (existing?.text && part.text) existing.ambiguous = true;
      else if (!existing?.text) record.parts.set(key, part);
    }
    record.commentary ||= byIndex.commentary;
    for (const [key, value] of tracker.ids) if (value === byIndex) tracker.ids.set(key, record);
    for (const [key, value] of tracker.indexes)
      if (value === byIndex) tracker.indexes.set(key, record);
    tracker.records.delete(byIndex);
  }
  if (!record && byIndex && (id === undefined || byIndex.id === undefined || byIndex.id === id)) {
    record = byIndex;
  }
  if (!record && allowAnonymousMatch && tracker.records.size === 1) {
    const only = tracker.records.values().next().value as MessageRecord;
    if (
      (id === undefined && index === undefined) ||
      (only.id === undefined && only.index === undefined)
    )
      record = only;
  }
  if (!record && id === undefined && index === undefined && tracker.records.size > 0) return null;
  if (
    !record &&
    !allowAnonymousMatch &&
    [...tracker.records].some(
      (candidate) =>
        candidate.id === undefined &&
        candidate.index === undefined &&
        [...candidate.parts.values()].some((part) => part.text.length > 0)
    )
  )
    return null;
  if (!record) {
    record = { commentary: false, parts: new Map() };
    tracker.records.add(record);
  }
  if (id !== undefined) {
    record.id = id;
    tracker.ids.set(id, record);
  }
  if (index !== undefined) {
    record.index = index;
    tracker.indexes.set(index, record);
  }
  if (data.item?.phase === "commentary" || data.phase === "commentary") record.commentary = true;
  return record;
}

function emitPart(
  state,
  data,
  kind: "content" | "refusal",
  text,
  snapshot: boolean,
  allowAnonymousMatch = true
) {
  if (typeof text !== "string" || text.length === 0) return null;
  if (snapshot && kind === "refusal" && text.trim().length === 0) return null;
  const record = messageRecord(state, data, allowAnonymousMatch);
  if (
    !record ||
    (state.dropResponsesCommentary !== false &&
      (record.commentary || data.part?.phase === "commentary"))
  )
    return null;
  const contentIndex =
    Number.isInteger(data.content_index) && data.content_index >= 0
      ? data.content_index
      : undefined;
  let key = `${contentIndex ?? "?"}:${kind}`;
  let sameKindCount = 0;
  let singleKey: string | undefined;
  let anonymousPart = false;
  for (const candidate of record.parts.keys()) {
    if (!candidate.endsWith(`:${kind}`)) continue;
    sameKindCount++;
    singleKey = candidate;
    anonymousPart ||= candidate === `?:${kind}`;
  }
  if (snapshot && data.allowPartFallback === false && anonymousPart) return null;
  if (
    !record.parts.has(key) &&
    sameKindCount === 1 &&
    data.allowPartFallback !== false &&
    (contentIndex === undefined || singleKey === `?:${kind}`)
  ) {
    if (contentIndex === undefined) key = singleKey!;
    else {
      record.parts.set(key, record.parts.get(singleKey!)!);
      record.parts.delete(singleKey!);
    }
  } else if (snapshot && contentIndex === undefined && sameKindCount > 1) return null;
  const part: EmittedPart = record.parts.get(key) ?? { text: "", ambiguous: false };
  record.parts.set(key, part);
  // A snapshot can extend a streamed prefix, but cannot rewrite text already
  // delivered to a client. Non-prefix snapshots are therefore not appended.
  let missing = snapshot
    ? !part.ambiguous && text.startsWith(part.text)
      ? text.slice(part.text.length)
      : ""
    : text;
  if (kind === "refusal" && !part.text) {
    if (snapshot) {
      // Snapshots contain the whole part, including any buffered prefix.
      part.pendingRefusal = undefined;
    } else {
      missing = (part.pendingRefusal ?? "") + missing;
      if (missing.trim().length === 0) {
        part.pendingRefusal = missing;
        return null;
      }
      part.pendingRefusal = undefined;
    }
  }
  if (!missing) return null;
  part.text += missing;
  if (kind === "refusal") state.responsesRefusalObserved = true;
  // The stream layer accumulates output_text.delta itself, not terminal snapshots.
  if ((snapshot || kind === "refusal") && typeof state.accumulatedContent === "string") {
    state.accumulatedContent = appendBoundedText(state.accumulatedContent, missing);
  }
  return {
    id: state.chatId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model || "gpt-4",
    choices: [{ index: 0, delta: { [kind]: missing }, finish_reason: null }],
  };
}

function recoverPart(state, data, part, allowAnonymousMatch = true) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "refusal") {
    return emitPart(state, { ...data, part }, "refusal", part.refusal, true, allowAnonymousMatch);
  }
  if (part.type === "output_text" || part.type === "text" || part.type == null) {
    return emitPart(state, { ...data, part }, "content", part.text, true, allowAnonymousMatch);
  }
  return null;
}

function recoverMessage(state, data, allowAnonymousMatch = true) {
  const record = messageRecord(state, data, allowAnonymousMatch);
  if (!record || (record.commentary && state.dropResponsesCommentary !== false)) return null;
  const content = data.item?.content;
  if (typeof content === "string") {
    return emitPart(
      state,
      { ...data, content_index: 0 },
      "content",
      content,
      true,
      allowAnonymousMatch
    );
  }
  const chunks = [];
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const chunk = recoverPart(
        state,
        { ...data, content_index: i, allowPartFallback: content.length === 1 },
        content[i],
        allowAnonymousMatch
      );
      if (chunk) chunks.push(chunk);
    }
  }
  return chunks.length ? chunks : null;
}

/** undefined means this is not a message/text event; null means no new text. */
export function translateResponsesTextEvent(state, eventType, data) {
  if (eventType === "response.output_item.added" && data.item?.type === "message") {
    messageRecord(state, data);
    return null;
  }
  if (eventType === "response.output_item.done" && data.item?.type === "message") {
    return recoverMessage(state, data);
  }
  if (eventType === "response.content_part.added") {
    messageRecord(state, data);
    return null;
  }
  if (eventType === "response.content_part.done") return recoverPart(state, data, data.part);
  if (eventType === "response.output_text.delta")
    return emitPart(state, data, "content", data.delta, false);
  if (eventType === "response.output_text.done")
    return emitPart(state, data, "content", data.text, true);
  if (eventType === "response.refusal.delta")
    return emitPart(state, data, "refusal", data.delta, false);
  if (eventType === "response.refusal.done")
    return emitPart(state, data, "refusal", data.refusal, true);
  return undefined;
}

export function synthesizeCompletedMessageText(state, output) {
  if (!Array.isArray(output) || state.finishReasonSent) return [];
  const messageCount = output.filter((item) => item?.type === "message").length;
  const chunks = [];
  for (let index = 0; index < output.length; index++) {
    const item = output[index];
    if (item?.type !== "message") continue;
    const recovered = recoverMessage(state, { item, output_index: index }, messageCount === 1);
    if (Array.isArray(recovered)) chunks.push(...recovered);
    else if (recovered) chunks.push(recovered);
  }
  return chunks;
}
