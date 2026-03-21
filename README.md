# joo-agent-core

基于 [@mariozechner/pi-agent-core](https://www.npmjs.com/package/@mariozechner/pi-agent-core)，用 [XState](https://stately.ai/docs) 把 **对话阶段** 建成状态机：**每个状态只暴露当前允许的 `AgentTool`**，非法调用在 `beforeToolCall` 里拦截。

## 适合做什么

- 多阶段任务（收集信息 → 执行 → 收尾），希望 **工具集随阶段变化**，而不是一次性塞给模型一长串工具。
- 需要在 **工具执行后** 用 `deriveEventFromTool` 把结果映射成 XState 事件，驱动状态迁移。

## 要求

- **Node.js** ≥ 20

## 安装

```bash
npm install joo-agent-core
```

从本仓库开发时：先 `npm install`，再 `npm run build`。

## 工作原理（简要）

1. 在状态 `meta` 里声明各阶段工具（或用自定义 `resolveTools`）。
2. `createAgent` 创建 `Agent` + XState `actor`；快照变化时 **`setTools`**，与图上可用工具一致。
3. 模型只能调用当前快照允许的工具；否则 `beforeToolCall` 返回 block。
4. 可选：`afterToolCall` 链上根据工具结果 `deriveEventFromTool` → `actor.send`（仅当 `snapshot.can(event)`）。

## 用法示例

```ts
import { createAgent, toolsFromMeta } from "joo-agent-core";

const { agent, send } = createAgent({
  agentOptions: {
    initialState: { model, systemPrompt: "...", tools: [] },
  },
  machine: yourMachine,
  resolveTools: (snapshot) => toolsFromMeta(snapshot),
  hooks: {
    deriveEventFromTool: (ctx) => {
      /* 返回 XState 事件，或 undefined */
    },
    onTransition: ({ from, to }) => {
      /* 可选 */
    },
  },
});

await agent.prompt("...");
```

## 事件与订阅


| 方式                                | 内容                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `agent.subscribe`                 | 仅 pi-agent 流式事件（如 `tool_execution_*` 等）。                                                                   |
| `subscribeStateChange`            | 仅 XState 状态值变化 `{ from, to }`。                                                                             |
| `subscribe`                       | **合并** 上述两类：`{ kind: "agent", event }` 与 `{ kind: "state_change", payload }`（类型见 `AgentWithMachineEvent`）。 |
| `eventBus` + `STATE_CHANGE_EVENT` | 把 `state_change` 接到你自己的 `createEventBus` 泛型里，与应用其它事件并列。                                                    |


`state_change` 与 `eventBus` 的投递在微任务中排队，以便在由 `afterToolCall` 触发的迁移场景下，与 pi-agent 的 `tool_execution_end` 顺序一致（详见源码注释）。

## 子路径导出


| 子路径                      | 说明                                                                   |
| ------------------------ | -------------------------------------------------------------------- |
| `joo-agent-core`         | 主入口，聚合导出                                                             |
| `joo-agent-core/agent`   | `createAgent`、`subscribe`、`STATE_CHANGE_EVENT`、相关类型 |
| `joo-agent-core/machine` | `toolsFromMeta`、`ToolPhaseMeta`                                      |
| `joo-agent-core/event`   | `createEventBus`                                                     |


## 运行仓库内示例

```bash
npm run example
```

示例默认 **Kimi For Coding**（`getModel("kimi-coding", "k2p5")`）。在仓库根目录配置 `.env`：

```bash
KIMI_API_KEY=...
```

未设置密钥时不会请求真实 API，只打印初始状态与工具名后退出。其它厂商环境变量见 `@mariozechner/pi-ai` 文档。

## 更多说明

维护者向的目录约定、TypeScript 与改动注意点见 [AGENTS.md](./AGENTS.md)。

## 许可

ISC（见 `package.json`）。