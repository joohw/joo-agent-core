import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
import type { AgentMessage } from "../src/pi-agent/types.js";

/** Sum `usage` across all assistant messages (one entry per LLM completion in the run). */
export function sumAssistantUsage(messages: AgentMessage[]): Usage {
  const sum: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const u = (m as AssistantMessage).usage;
    sum.input += u.input;
    sum.output += u.output;
    sum.cacheRead += u.cacheRead;
    sum.cacheWrite += u.cacheWrite;
    sum.totalTokens += u.totalTokens;
    sum.cost.input += u.cost.input;
    sum.cost.output += u.cost.output;
    sum.cost.cacheRead += u.cost.cacheRead;
    sum.cost.cacheWrite += u.cost.cacheWrite;
    sum.cost.total += u.cost.total;
  }
  return sum;
}

export function formatUsageLine(u: Usage): string {
  return `input=${u.input} output=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} totalTokens=${u.totalTokens} cost=${u.cost.total.toFixed(6)}`;
}
