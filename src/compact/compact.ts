import type { AgentMessage } from "../pi-agent/types.js";
import type { UserMessage } from "@mariozechner/pi-ai";

export interface CompactOptions {
  /**
   * Always keep the last N messages (across all roles/custom messages), **after** any leading pinned
   * prefix (see {@link compact}).
   * Default: 30
   */
  keepLastMessages?: number;
  /**
   * Approximate token budget for the whole message list (prefix + placeholder + tail).
   * Default: 24000
   */
  maxEstimatedTokens?: number;
  /**
   * Minimum messages to keep even if still over budget.
   * Default: 8
   */
  minKeepLastMessages?: number;
  /**
   * Placeholder text used to replace omitted earlier context.
   * Default: Chinese + English marker.
   */
  placeholderText?: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object";
}

/**
 * Leading messages that must never be compacted away (consecutive from index 0).
 * - `role === "system"` (custom / extended agent messages)
 * - `compactKeep === true` on the message object (opt-in for app-specific "system-like" rows)
 *
 * Note: `Agent.systemPrompt` is **not** in `messages`; the runtime passes it separately to the LLM.
 * This function does not receive `systemPrompt` — it is always preserved by `pi-agent`.
 */
function leadingPinnedPrefix(messages: AgentMessage[]): { prefix: AgentMessage[]; rest: AgentMessage[] } {
  const prefix: AgentMessage[] = [];
  for (const m of messages) {
    if (!isRecord(m)) break;
    const role = m["role"];
    if (String(role) === "system" || m["compactKeep"] === true) {
      prefix.push(m);
      continue;
    }
    break;
  }
  return { prefix, rest: messages.slice(prefix.length) };
}

function contentToTextLen(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (typeof part === "string") {
        n += part.length;
      } else if (isRecord(part)) {
        const t = part["text"];
        if (typeof t === "string") n += t.length;
        else n += JSON.stringify(part).length;
      } else {
        n += String(part).length;
      }
    }
    return n;
  }
  if (isRecord(content)) {
    const t = content["text"];
    if (typeof t === "string") return t.length;
    return JSON.stringify(content).length;
  }
  return String(content ?? "").length;
}

function estimateChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (!isRecord(m)) continue;
    const role = m["role"];
    if (role === "user" || role === "assistant" || role === "toolResult") {
      total += contentToTextLen(m["content"]);
      if (role === "toolResult") {
        total += contentToTextLen(m["toolName"]);
        total += contentToTextLen(m["toolCallId"]);
      }
    } else {
      total += JSON.stringify(m).length;
    }
  }
  return total;
}

function estimateTokensApprox(messages: AgentMessage[]): number {
  const chars = estimateChars(messages);
  return Math.ceil(chars / 3);
}

function makePlaceholder(timestamp: number, text: string): UserMessage {
  return { role: "user", content: text, timestamp };
}

function compactRest(
  rest: AgentMessage[],
  opts: CompactOptions,
  placeholderTs: number,
  /** Included in token estimates so compaction respects total budget when a pinned prefix exists. */
  prefixForBudget: AgentMessage[]
): AgentMessage[] {
  const keepLastMessagesDefault = 30;
  const minKeepDefault = 8;
  const maxEstimatedTokensDefault = 24_000;
  const placeholderTextDefault =
    "[上下文已压缩：更早的对话已被占位符替换 / context compacted: older messages omitted]";

  const minKeepLastMessages = Math.max(0, opts.minKeepLastMessages ?? minKeepDefault);
  let keepLastMessages = Math.max(minKeepLastMessages, opts.keepLastMessages ?? keepLastMessagesDefault);
  const maxEstimatedTokens = Math.max(1, opts.maxEstimatedTokens ?? maxEstimatedTokensDefault);
  const placeholderText = opts.placeholderText ?? placeholderTextDefault;

  if (!Array.isArray(rest) || rest.length === 0) return rest;

  const full = (): AgentMessage[] => [...prefixForBudget, ...rest];
  let estimated = estimateTokensApprox(full());

  if (rest.length <= keepLastMessages + 1 && estimated <= maxEstimatedTokens) return rest;

  while (estimated > maxEstimatedTokens && keepLastMessages > minKeepLastMessages) {
    keepLastMessages = Math.max(minKeepLastMessages, keepLastMessages - 2);
    const tail = rest.slice(-keepLastMessages);
    const candidate = [makePlaceholder(placeholderTs, placeholderText), ...tail];
    estimated = estimateTokensApprox([...prefixForBudget, ...candidate]);
    if (keepLastMessages === minKeepLastMessages) break;
  }

  if (rest.length <= keepLastMessages + 1 && estimated <= maxEstimatedTokens) return rest;

  const tail = rest.slice(-keepLastMessages);
  return [makePlaceholder(placeholderTs, placeholderText), ...tail];
}

/**
 * Compact conversation context to reduce context window pressure.
 *
 * **System instructions:** `Agent` stores `systemPrompt` outside `messages`; the model always receives
 * it unchanged. This helper only transforms `messages` (what `transformContext` receives).
 *
 * **Pinned prefix:** Leading consecutive messages with `role: "system"` or `compactKeep: true` are
 * always kept; compaction applies only to the remainder.
 *
 * Strategy for the remainder:
 * - Keep the most recent messages intact.
 * - Replace omitted earlier messages with a single placeholder `user` message.
 */
export function compact(messages: AgentMessage[], opts: CompactOptions = {}): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const { prefix, rest } = leadingPinnedPrefix(messages);
  if (rest.length === 0) return messages;

  const first = rest[0];
  const placeholderTs =
    isRecord(first) && typeof first["timestamp"] === "number" ? (first["timestamp"] as number) : Date.now();

  const compactedRest = compactRest(rest, opts, placeholderTs, prefix);
  return [...prefix, ...compactedRest];
}
