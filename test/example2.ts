/**
 * Demo: **同 example.ts 的电子宠物场景**，但**不使用状态机** —— 全部工具始终注册在列表里，便于与 `example.ts` 对比。
 *
 * - `example.ts`：状态决定当前可见工具，非法调用会被拦截。
 * - `example2`：无 phase FSM，模型始终看到 `wake_up` / `feed` / … 全套工具，依赖提示词与模型自律。
 *
 * Run: npx tsx test/example2.ts  （或 npm run example2）
 * Requires provider API keys (see @mariozechner/pi-ai).
 * Loads `.env` from repo root when present (see dotenv).
 *
 * Live calls use **Kimi For Coding** only: `KIMI_API_KEY` + `getModel("kimi-coding", "k2p5")`.
 */
import "dotenv/config";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../src/pi-agent/types.js";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { createAgent } from "../src/agent/createAgent.js";
import { sumSessionTotalTokens } from "./sumAssistantUsage.js";

const hasKimiKey = Boolean(process.env.KIMI_API_KEY?.trim());

const exampleModel = getModel("kimi-coding", "k2p5");

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

/**
 * 与 example 各状态 meta.tools 的并集（去重）：始终全部暴露给模型。
 * 工具描述与 example 一致，便于对照。
 */
const tools: AgentTool[] = [
  actionTool(
    "wake_up",
    "叫醒宠物",
    "宠物在睡觉。只有叫醒之后才能喂食或出门。",
    (n) => `[叫醒] ${n}`
  ),
  actionTool("feed", "喂食", "给宠物喂食。吃完会进入「吃饱」状态，此时不能再喂，需要先玩或散步。", (n) => `[喂食] ${n}`),
  actionTool("go_walk", "出门散步", "带宠物出门散步（进入「散步中」）。", (n) => `[出门散步] ${n}`),
  actionTool("lights_out", "关灯睡觉", "结束一天，让宠物入睡。", (n) => `[睡觉] ${n}`),
  actionTool("play", "玩耍", "和宠物玩一会儿，消化一下，回到「空闲」。", (n) => `[玩耍] ${n}`),
  actionTool(
    "finish_walk",
    "散步结束回家",
    "结束散步，回到家中（回到「空闲」）。",
    (n) => `[回家] ${n}`
  ),
];

const { agent } = createAgent({
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
      tools,
    },
  },
  resolveTools: () => [],
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
    const tcs = msg.content.filter((c) => c.type === "toolCall");
    const text = msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (tcs.length > 0) {
      console.error("\n[assistant] tool call(s):", tcs.map((t) => t.name).join(", "));
    }
    if (streamedTextChars === 0 && text.trim().length > 0) {
      console.error("\n[assistant] (non-streamed text)\n", text);
    }
    if (streamedTextChars === 0 && text.trim().length === 0 && tcs.length === 0) {
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
  console.error(
    "Set KIMI_API_KEY in .env (Kimi For Coding) to run a live prompt. [example2] static tool list (no state machine):",
    tools.map((t) => t.name).join(", ")
  );
  process.exit(0);
}

try {
  console.error("[example2] kimi-coding / k2p5 — same pet scenario as example, no state machine");
  await agent.prompt(
    "宠物现在在睡觉。请按照照顾流程照顾它：先叫醒，再喂食，然后带它出门散步，散步结束后哄它睡觉。每一步用对应工具完成，并简单告诉我发生了什么。"
  );
  if (agent.state.error) console.error("\n[example2] agent.state.error:", agent.state.error);
  console.error("\n[example2] prompt finished");
} catch (err) {
  console.error("\n[example2] prompt failed:", err);
  process.exitCode = 1;
}
