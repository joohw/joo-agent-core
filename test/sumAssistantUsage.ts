import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentMessage } from "../src/pi-agent/types.js";

/** Sum `usage.totalTokens` for each assistant message in this `prompt` run (one completion per turn). */
export function sumSessionTotalTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    total += (m as AssistantMessage).usage.totalTokens;
  }
  return total;
}
