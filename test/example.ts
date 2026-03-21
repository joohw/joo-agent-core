/**
 * Demo: XState chart with `meta.tools` per phase + pi-agent `Agent`.
 * Run: npx tsx test/example.ts  （或 npm run example）
 * Requires provider API keys (see @mariozechner/pi-ai).
 * Loads `.env` from repo root when present (see dotenv).
 *
 * Live calls use **Kimi For Coding** only: `KIMI_API_KEY` + `getModel("kimi-coding", "k2p5")`.
 * That key must be issued for `api.kimi.com/coding` (not the same as Moonshot `api.moonshot.cn` keys).
 */
import "dotenv/config";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { createActor, setup, type Actor } from "xstate";
import { createAgentWithXStateMachine } from "../src/agent/createAgentWithXStateMachine.js";
import { toolsFromMeta } from "../src/machine/xstateHelpers.js";

const hasKimiKey = Boolean(process.env.KIMI_API_KEY?.trim());

const exampleModel = getModel("kimi-coding", "k2p5");

function textTool(name: string, label: string, description: string): AgentTool {
  return {
    name,
    label,
    description,
    parameters: Type.Object({
      note: Type.String({ description: "Short note for the user" }),
    }),
    execute: async (_id, params) => ({
      content: [{ type: "text", text: `[${name}] ${(params as { note: string }).note}` }],
      details: {},
    }),
  };
}

/** First phase only: call after reading the workflow manual; completion triggers `manual_done` → gather. */
const readOperatorManualTool: AgentTool = {
  name: "read_operator_manual",
  label: "Read operator manual",
  description:
    "Confirm you have read the operator / workflow manual (说明书). Call once when ready; this advances the workflow to the gather phase.",
  parameters: Type.Object({
    note: Type.String({ description: "Brief confirmation (e.g. key points you understood)" }),
  }),
  execute: async (_id, params) => ({
    content: [{ type: "text", text: `[read_operator_manual] ${(params as { note: string }).note}` }],
    details: {},
  }),
};

const toolsReadManual: AgentTool[] = [readOperatorManualTool];

/** Advances the XState chart; transitions are derived in `deriveEventFromTool` from the current snapshot (not from free text). */
const markPhaseDoneTool: AgentTool = {
  name: "mark_phase_done",
  label: "Mark phase done",
  description:
    "Call when the current phase is complete to move to the next phase. Do not rely on natural-language cues alone — this tool is what updates workflow state.",
  parameters: Type.Object({
    note: Type.String({ description: "Short note (e.g. what was completed)" }),
  }),
  execute: async (_id, params) => ({
    content: [{ type: "text", text: `[mark_phase_done] ${(params as { note: string }).note}` }],
    details: {},
  }),
};

const toolsGather: AgentTool[] = [
  textTool("collect_requirements", "Collect requirements", "Capture what the user wants before acting."),
  markPhaseDoneTool,
];

const toolsAct: AgentTool[] = [
  textTool("run_step", "Run step", "Perform one concrete step toward the goal."),
  markPhaseDoneTool,
];

const toolsReview: AgentTool[] = [
  textTool("summarize", "Summarize", "Summarize results for the user."),
  markPhaseDoneTool,
];

const toolWorkflow = setup({
  types: {
    context: {} as Record<string, never>,
    events: {} as
      | { type: "manual_done" }
      | { type: "gather_done" }
      | { type: "act_done" }
      | { type: "review_done" },
    meta: {} as { tools: AgentTool[] },
  },
}).createMachine({
  id: "toolWorkflow",
  context: {},
  initial: "readManual",
  states: {
    readManual: {
      meta: { tools: toolsReadManual },
      on: { manual_done: "gather" },
    },
    gather: {
      meta: { tools: toolsGather },
      on: { gather_done: "act" },
    },
    act: {
      meta: { tools: toolsAct },
      on: { act_done: "review" },
    },
    review: {
      meta: { tools: toolsReview },
      on: { review_done: "gather" },
    },
  },
});

/** Set immediately after `createAgentWithXStateMachine` so `deriveEventFromTool` can read the current state. */
let actorForPhaseHooks: Actor<typeof toolWorkflow> | null = null;

const { agent, actor, send, subscribe } = createAgentWithXStateMachine({
  agentOptions: {
    initialState: {
      systemPrompt: [
        "You are a phased assistant. Tools are gated by phase — only call tools that exist in the current phase.",
        "",
        "## Operator manual (read this first)",
        "1) **readManual** phase: only **read_operator_manual** exists. Read this section, then call **read_operator_manual** once with a short note. That moves you to gather.",
        "2) **gather** → **act** → **review**: each phase has its own tools plus **mark_phase_done**.",
        "3) When a phase is truly finished, call **mark_phase_done** (short note) to advance. Natural language alone does not change machine state.",
        "4) Phase tools: gather uses collect_requirements; act uses run_step; review uses summarize.",
      ].join("\n"),
      model: exampleModel,
    },
  },
  machine: toolWorkflow,
  resolveTools: (s) => toolsFromMeta(s),
  hooks: {
    deriveEventFromTool: (ctx):
      | { type: "manual_done" }
      | { type: "gather_done" }
      | { type: "act_done" }
      | { type: "review_done" }
      | undefined => {
      const a = actorForPhaseHooks;
      if (!a) return undefined;
      const value = a.getSnapshot().value;
      if (ctx.toolCall.name === "read_operator_manual" && value === "readManual") {
        return { type: "manual_done" };
      }
      if (ctx.toolCall.name !== "mark_phase_done") return undefined;
      if (value === "gather") return { type: "gather_done" };
      if (value === "act") return { type: "act_done" };
      if (value === "review") return { type: "review_done" };
      return undefined;
    },
  },
});
actorForPhaseHooks = actor;

void send; // e.g. send({ type: "gather_done" }) from UI

/** Count streamed text so we can print non-streaming completions (some providers batch output → few/no `text_delta` events). */
let streamedTextChars = 0;

/**
 * 单一订阅：`kind: "agent"` 为 pi-agent 流式协议；`kind: "state_change"` 为 XState（仅状态值变化；未调用 **mark_phase_done** 则不会进入下一阶段）。
 */
subscribe((u) => {
  if (u.kind === "state_change") {
    const { from, to } = u.payload;
    console.error(`[state_change] ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
    return;
  }
  const ev = u.event;
  if (ev.type === "agent_start") {
    console.error("[agent] started");
    return;
  }
  if (ev.type === "message_update") {
    const inner = ev.assistantMessageEvent;
    if (inner.type === "text_delta") {
      streamedTextChars += inner.delta.length;
      process.stdout.write(inner.delta);
    } else if (inner.type === "thinking_delta") {
      process.stderr.write(inner.delta);
    }
    return;
  }
  if (ev.type === "message_end" && ev.message.role === "assistant") {
    const msg = ev.message as AssistantMessage;
    if (msg.stopReason === "error" || msg.stopReason === "aborted" || msg.errorMessage) {
      console.error("\n[assistant] request failed — stopReason:", msg.stopReason);
      if (msg.errorMessage) console.error("  details:", msg.errorMessage);
      const errText = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();
      if (errText) console.error("  message text:", errText);
      if (!msg.errorMessage && !errText) {
        console.error(
          "  hint: KIMI_API_KEY must be valid for Kimi For Coding (api.kimi.com/coding). Moonshot open-platform keys may differ."
        );
      }
      streamedTextChars = 0;
      return;
    }
    const tools = msg.content.filter((c) => c.type === "toolCall");
    const text = msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (tools.length > 0) {
      console.error("\n[assistant] tool call(s):", tools.map((t) => t.name).join(", "));
    }
    if (streamedTextChars === 0 && text.trim().length > 0) {
      console.error("\n[assistant] (non-streamed text)\n", text);
    }
    if (streamedTextChars === 0 && text.trim().length === 0 && tools.length === 0) {
      console.error("\n[assistant] empty message (stopReason:", msg.stopReason, ")");
    }
    if (streamedTextChars > 0) {
      process.stdout.write("\n");
    }
    streamedTextChars = 0;
    return;
  }
  if (ev.type === "tool_execution_start") {
    console.error(`\n[tool start] ${ev.toolName}`);
    return;
  }
  if (ev.type === "tool_execution_end") {
    console.error(`[tool end] ${ev.toolName}${ev.isError ? " (error)" : ""}`);
  }
});

if (!hasKimiKey) {
  const dry = createActor(toolWorkflow);
  dry.start();
  const snap = dry.getSnapshot();
  console.error(
    "Set KIMI_API_KEY in .env (Kimi For Coding) to run a live prompt. Initial state:",
    snap.value,
    "tools:",
    toolsFromMeta(snap).map((t) => t.name)
  );
  process.exit(0);
}

try {
  console.error("[example] kimi-coding / k2p5");
  console.error("[xstate] initial", JSON.stringify(actor.getSnapshot().value));
  await agent.prompt("I want to plan a small CLI tool, then build it, then review.");
  if (agent.state.error) console.error("\n[example] agent.state.error:", agent.state.error);
  console.error("\n[xstate] final", JSON.stringify(actor.getSnapshot().value));
  console.error("\n[example] prompt finished");
} catch (err) {
  console.error("\n[example] prompt failed:", err);
  process.exitCode = 1;
}
