# joo-agent-core

基于 [@mariozechner/pi-agent-core](https://www.npmjs.com/package/@mariozechner/pi-agent-core)，用内置的 **轻量阶段状态机**（`MachineDefinition` + `createMachine`）把 **对话阶段** 建成 FSM：**每个状态只暴露当前允许的 `AgentTool`**，非法调用在 `beforeToolCall` 里拦截。

## 适合做什么

- 多阶段任务（收集信息 → 执行 → 收尾），希望 **工具集随阶段变化**，而不是一次性塞给模型一长串工具。
- 需要在 **工具执行后** 用 `deriveEventFromTool` 把结果映射成 `{ type: string }` 事件，驱动状态迁移。

## 要求

- **Node.js** ≥ 20

## 安装

```bash
npm install joo-agent-core
```

从本仓库开发时：先 `npm install`，再 `npm run build`。

## 工作原理（简要）

1. 在状态 `meta` 里声明各阶段工具（或用自定义 `resolveTools`）。
2. `createAgent` 创建 `Agent`（可选 `machine`：传入时会创建阶段机实例）；快照变化时 **`setTools`**，与当前阶段可用工具一致。默认会把会话持久化到 **`~/.joo-agent-core/sessions`**（见 `defaultJooAgentRoot()`，`await createAgent(...)`）；若不要落盘，请传 **`sessionStore: false`**。
3. 模型只能调用当前快照允许的工具；否则 `beforeToolCall` 返回 block。
4. 可选：`afterToolCall` 链上根据工具结果 `deriveEventFromTool` → `send(event)`（仅当对应机在当前状态下能消费该事件，即 `can(event)`）。

## 用法示例

```ts
import { createAgent, toolsFromMeta } from "joo-agent-core";

const { agent, send } = await createAgent({
  agentOptions: {
    initialState: { model, systemPrompt: "...", tools: [] },
  },
  // 可选：不传 machine 时等价于“仅基础 tools”的 agent
  machine: { id: "pet", machine: yourPetMachineDefinition },
  resolveTools: (snapshot) => toolsFromMeta(snapshot),
  hooks: {
    deriveEventFromTool: (ctx) => {
      /* 返回 { type: "..." } 事件，或 undefined */
    },
  },
});

await agent.prompt("...");
```

### 处理中追加（中断 + 合并后续消息）

当你希望“当前这轮先打断，后续碎片消息合并后再发”，可用 `interruptAndAppend`：

```ts
// 可在用户连续输入时反复调用
await agent.interruptAndAppend("先别按刚才的来");
await agent.interruptAndAppend("补充：目标改成 CLI");
await agent.interruptAndAppend("再补充：要支持 dry-run");

// 默认会：
// 1) 若 agent 正在处理，则 abort 当前轮次
// 2) 将处理中收到的后续消息放入候选区
// 3) 按 debounce 窗口（默认 400ms）合并后作为下一次 prompt 发送
```

可在 `agentOptions` 里设置默认窗口：

```ts
const { agent } = await createAgent({
  agentOptions: {
    initialState: { model, systemPrompt: "...", tools: [] },
    interruptDebounceMs: 500,
  },
  resolveTools: () => [],
});
```

## 事件与订阅

本包不额外定义“状态变化事件”。订阅统一使用 `agent.subscribe(...)`（pi-agent 的流式事件，如 `message_*` / `tool_execution_*`）。

## 子路径导出


| 子路径                      | 说明                                                                   |
| ------------------------ | -------------------------------------------------------------------- |
| `joo-agent-core`         | 主入口，聚合导出                                                             |
| `joo-agent-core/agent`   | `Agent`、`createAgent`、路径辅助（`defaultJooAgentRoot`、`resolveJooAgentDirs` 等）、相关类型 |
| `joo-agent-core/session` | `SessionStore`、`createFileSessionStore`、`AgentSessionData` |
| `joo-agent-core/machine` | `toolsFromMeta`、`createMachine`、`MachineDefinition`、`MachineSpec` / `MachineSpecs` |
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