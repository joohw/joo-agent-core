# joo-agent-core

在 `[@mariozechner/pi-agent-core](https://www.npmjs.com/package/@mariozechner/pi-agent-core)` 之上，用 **[XState](https://stately.ai/docs)** 按**阶段**切换 **可用工具列表**：每个状态只暴露当前阶段允许的 `AgentTool`，并在 `beforeToolCall` 中拦截非法调用。

## 特性

- **状态与工具一致**：状态机迁移时 `setTools`，与图上的 `meta.tools`（或自定义 `resolveTools`）对齐。
- **可编程推进**：通过 `deriveEventFromTool` 在工具执行结束后向 XState `send` 事件（仅在 `snapshot.can(event)` 时发送）。
- **状态通知（非 Agent 流式事件）**：`subscribeStateChange`、可选 `eventBus`，或 **`subscribe`** 一次订阅合并 `AgentEvent`（`kind: "agent"`）与 `state_change`（`kind: "state_change"`）；类型见 `AgentWithMachineEvent`。
- **应用事件总线**：`createEventBus` 仍为通用 `on`/`emit`；可将 `state_change` 与其它事件一并写在泛型里。

## 要求

- **Node** ≥ 20

## 安装

```bash
npm install joo-agent-core
```

（若从源码使用：先 `npm install`，再 `npm run build`。）

## 子路径导出


| 路径                       | 说明                               |
| ------------------------ | -------------------------------- |
| `joo-agent-core`         | 聚合导出                             |
| `joo-agent-core/agent`   | `createAgentWithXStateMachine`、`subscribe`、`AgentWithMachineEvent` 等 |
| `joo-agent-core/machine` | `toolsFromMeta`、`ToolPhaseMeta`  |
| `joo-agent-core/event`   | `createEventBus`                 |


## 用法概要

1. 用 XState 定义状态机，在状态的 `meta` 里挂上各阶段 `tools`（或使用自己的 `resolveTools`）。
2. 调用 `createAgentWithXStateMachine`，传入 `agentOptions`、`machine`、`resolveTools`（常用 `toolsFromMeta`）。
3. 使用返回的 `agent` 做对话与订阅；使用 `actor` / `send` 与状态机交互。

```ts
import { createAgentWithXStateMachine, toolsFromMeta } from "joo-agent-core";
// 或：from "joo-agent-core/agent" 与 "joo-agent-core/machine"

const { agent, send } = createAgentWithXStateMachine({
  agentOptions: { initialState: { model, systemPrompt: "...", tools: [] } },
  machine: yourMachine,
  resolveTools: (s) => toolsFromMeta(s),
  hooks: {
    deriveEventFromTool: (ctx) => {
      /* 根据工具结果返回 XState 事件，或 undefined */
    },
    onTransition: ({ from, to }) => {
      /* 可选：日志或 UI */
    },
  },
});

await agent.prompt("...");
```

**状态切换**（XState `from` → `to`）用 **`subscribeStateChange`** 或传入 **`eventBus`**，不要与 **`agent.subscribe`**（模型流式、`tool_execution_*` 等）混在同一套回调里。示例见 `test/example.ts`。

## 示例

```bash
npm run example
```

示例使用 **Kimi For Coding**（`getModel("kimi-coding", "k2p5")`）。在仓库根目录配置 `.env`：

```bash
KIMI_API_KEY=...
```

未设置密钥时，示例不会请求真实 API，仅打印初始状态与工具名后退出。其他厂商密钥见 `@mariozechner/pi-ai` 文档。

## 文档与约定

更细的目录说明、TypeScript 约定与改动注意点见 **[AGENTS.md](./AGENTS.md)**。

## 许可

ISC（见 `package.json`）。