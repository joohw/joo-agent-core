/**
 * Demo: pet-care state machine — each state exposes only allowed actions (feed / walk / sleep / …).
 * Run: npx tsx test/example.ts  （或 npm run example）
 * Requires provider API keys (see @mariozechner/pi-ai).
 * Loads `.env` from repo root when present (see dotenv).
 *
 * Live calls use **Kimi For Coding** only: `KIMI_API_KEY` + `getModel("kimi-coding", "k2p5")`.
 * That key must be issued for `api.kimi.com/coding` (not the same as Moonshot `api.moonshot.cn` keys).
 */
import "dotenv/config";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../src/pi-agent/types.js";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { createAgent } from "../src/agent/createAgent.js";
import { createEventBus, STATE_CHANGE_EVENT, type AgentPhaseEventBus } from "../src/event/index.js";
import { createMachine, type MachineHandle } from "../src/machine/machine.js";
import { toolsFromMeta } from "../src/machine/metaHelpers.js";
import { sumSessionTotalTokens } from "./sumAssistantUsage.js";

const hasKimiKey = Boolean(process.env.KIMI_API_KEY?.trim());

const exampleModel = getModel("kimi-coding", "k2p5");

const PET_MACHINE_ID = "pet" as const;

function actionTool(
  name: string,
  label: string,
  description: string,
  ack: (note: string) => string
): AgentTool {
  return {
    name,
    label,
    description,
    parameters: Type.Object({
      note: Type.String({ description: "简短说明（给主人的反馈）" }),
    }),
    execute: async (_id, params) => ({
      content: [{ type: "text", text: ack((params as { note: string }).note) }],
      details: {},
    }),
  };
}

/** 睡觉中：只能叫醒 */
const toolsSleeping: AgentTool[] = [
  actionTool(
    "wake_up",
    "叫醒宠物",
    "宠物在睡觉。只有叫醒之后才能喂食或出门。",
    (n) => `[叫醒] ${n}`
  ),
];

/** 空闲：喂食、出门散步、直接哄睡 */
const toolsIdle: AgentTool[] = [
  actionTool("feed", "喂食", "给宠物喂食。吃完会进入「吃饱」状态，此时不能再喂，需要先玩或散步。", (n) => `[喂食] ${n}`),
  actionTool("go_walk", "出门散步", "带宠物出门散步（进入「散步中」）。", (n) => `[出门散步] ${n}`),
  actionTool("lights_out", "关灯睡觉", "结束一天，让宠物入睡。", (n) => `[睡觉] ${n}`),
];

/** 刚吃饱：不能马上再喂，可以玩、散步或睡觉 */
const toolsFed: AgentTool[] = [
  actionTool("play", "玩耍", "和宠物玩一会儿，消化一下，回到「空闲」。", (n) => `[玩耍] ${n}`),
  actionTool("go_walk", "出门散步", "带宠物出门散步（进入「散步中」）。", (n) => `[出门散步] ${n}`),
  actionTool("lights_out", "关灯睡觉", "让宠物入睡。", (n) => `[睡觉] ${n}`),
];

/** 散步中：只能回家 */
const toolsWalking: AgentTool[] = [
  actionTool(
    "finish_walk",
    "散步结束回家",
    "结束散步，回到家中（回到「空闲」）。",
    (n) => `[回家] ${n}`
  ),
];

const petMachine = {
  initial: "sleeping" as const,
  states: {
    sleeping: {
      meta: { tools: toolsSleeping },
      on: { woke: "idle" },
    },
    idle: {
      meta: { tools: toolsIdle },
      on: { fed: "fed", walk: "walking", bedtime: "sleeping" },
    },
    fed: {
      meta: { tools: toolsFed },
      on: { played: "idle", walk: "walking", bedtime: "sleeping" },
    },
    walking: {
      meta: { tools: toolsWalking },
      on: { walk_done: "idle" },
    },
  },
};

/** Set immediately after `createAgent` so `deriveEventFromTool` can read the current state. */
let petActorForHooks: MachineHandle | null = null;

const phaseEventBus = createEventBus<AgentPhaseEventBus>();

/** 仓库示例不写会话文件；默认不传 `sessionStore` 时会持久化到 `~/.joo-agent-core/sessions`。 */
const { agent, phase: petPhase, send } = await createAgent({
  eventBus: phaseEventBus,
  agentOptions: {
    initialState: {
      systemPrompt: [
        "你是一个电子宠物养成助手。",
        "",
        "## 照顾流程（务必遵守）",
        "- **sleeping（睡觉）**：先 `wake_up`。",
        "- **idle（空闲）**：可 `feed`、`go_walk`、`lights_out`。",
        "- **fed（刚吃饱）**：不要立刻再 `feed`；可 `play`、`go_walk`、`lights_out`。",
        "- **walking（散步中）**：用 `finish_walk` 回家。",
        "",
        "请用简短中文回复用户，并在需要推进流程时调用合适的工具。",
      ].join("\n"),
      model: exampleModel,
    },
  },
  machine: { id: PET_MACHINE_ID, machine: petMachine },
  resolveTools: (s) => toolsFromMeta(s),
  hooks: {
    deriveEventFromTool: (ctx):
      | { type: "woke" }
      | { type: "fed" }
      | { type: "walk" }
      | { type: "bedtime" }
      | { type: "played" }
      | { type: "walk_done" }
      | undefined => {
      const a = petActorForHooks;
      if (!a) return undefined;
      const value = a.getSnapshot().value;
      const local = ctx.toolCall.name;

      if (local === "wake_up" && value === "sleeping") return { type: "woke" };
      if (local === "feed" && value === "idle") return { type: "fed" };
      if (local === "go_walk" && (value === "idle" || value === "fed")) return { type: "walk" };
      if (local === "lights_out" && (value === "idle" || value === "fed")) return { type: "bedtime" };
      if (local === "play" && value === "fed") return { type: "played" };
      if (local === "finish_walk" && value === "walking") return { type: "walk_done" };
      return undefined;
    },
  },
});
petActorForHooks = petPhase ?? null;

void send; // e.g. send({ type: "woke" }) from UI

phaseEventBus.on(STATE_CHANGE_EVENT, (p) => {
  console.error(`[pet] state_change ${p.machineId}: ${JSON.stringify(p.previousValue)} → ${JSON.stringify(p.nextValue)}`);
});

/** Count streamed text so we can print non-streaming completions (some providers batch output → few/no `text_delta` events). */
let streamedTextChars = 0;

agent.subscribe((ev) => {
  if (ev.type === "agent_start") {
    console.error("[agent] started");
    return;
  }
  if (ev.type === "agent_end") {
    console.error("\n[usage]", sumSessionTotalTokens(ev.messages));
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
  const dry = createMachine(petMachine);
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
  console.error("[example] kimi-coding / k2p5 — pet state machine");
  if (petPhase) console.error("[pet] initial state:", JSON.stringify(petPhase.getSnapshot().value));
  await agent.prompt(
    "宠物现在在睡觉。请按照照顾流程照顾它：先叫醒，再喂食，然后带它出门散步，散步结束后哄它睡觉。每一步用对应工具完成，并简单告诉我发生了什么。"
  );
  if (agent.state.error) console.error("\n[example] agent.state.error:", agent.state.error);
  if (petPhase) console.error("\n[pet] final state:", JSON.stringify(petPhase.getSnapshot().value));
  console.error("\n[example] prompt finished");
} catch (err) {
  console.error("\n[example] prompt failed:", err);
  process.exitCode = 1;
}
