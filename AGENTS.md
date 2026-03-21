# AGENTS.md — joo-agent-core


## 项目是什么

**joo-agent-core** 在 [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core) 之上，用 **XState** 按阶段切换 **可用工具列表**，使 agent 在不同状态只暴露对应 `AgentTool`。


## 目录与职责

| 路径 | 说明 |
|------|------|
| `src/agent/createAgent.ts` | 将 XState `Actor` 与 `Agent` 绑定：`setTools`、`beforeToolCall`；`subscribeStateChange` / `subscribe` / 可选 `eventBus` 的 `state_change`（与 `AgentEvent` 并行，可用 `subscribe` 合并） |
| `src/machine/xstateHelpers.ts` | 例如从 `state.meta.tools` 解析工具列表 |
| `src/event/eventBus.ts` | 通用事件总线（见下「事件总线」） |
| `src/index.ts` | 公共 API 聚合导出 |
| `test/example.ts` | 可运行示例：分阶段工具 + Kimi For Coding（`kimi-coding`） |

### 事件总线

`createEventBus` 不提供固定事件名：由你在泛型 `TEvents` 里声明。集成层会发出 **`state_change`**（`StateChangePayload`：`from` / `to`）：通过 **`subscribeStateChange`**，或 **`eventBus`** 传入 `createAgent`（`emit` 名见 `STATE_CHANGE_EVENT`）。也可在 `hooks.onTransition` 里自行 `emit` 到自建总线。以上均与 **Agent 流式 `AgentEvent`** 无关。

修改对外 API 时同步更新 `package.json` 的 `exports` 与 `src/index.ts`（及子路径 `agent` / `machine` / `event`）。

## 环境与运行

- **Node**：`>=20`（见 `package.json` `engines`）。
- **构建**：`npm run build`（`tsc` 输出到 `dist/`）。
- **示例**：`npm run example`（即 `tsx test/example.ts`）。

### pi-ai 环境变量（按所用 provider 设置）

示例 `test/example.ts` 仅使用 **Kimi For Coding**：在 `.env` 中设置 `KIMI_API_KEY`（与 Moonshot 开放平台 `api.moonshot.cn` 的密钥可能不是同一套，以 Kimi For Coding 控制台为准）。

其他厂商见 `node_modules/@mariozechner/pi-ai/README.md` 的 **Environment Variables (Node.js only)**。

未设置 `KIMI_API_KEY` 时，`test/example.ts` 会 **不调用真实 API**，仅打印 XState 初始状态与工具名后退出。

## TypeScript 约定

- **`module` / `moduleResolution`**：`NodeNext` —— 源码中 import 路径需带 **`.js` 后缀**（指向编译后的 `.js`），与现有文件一致。
- **`strict`**：保持开启；新增代码需通过类型检查。
- 公共类型与实现放在 `src/`，避免在无要求时新增根目录杂项文件。

## 改动时的注意点

- **只改任务所需文件**；不要顺带大段重构无关模块。
- 工具与状态机联动时，确认 `resolveTools` / `deriveEventFromTool` 与 XState 图上的 `meta.tools` 一致，避免状态与可用工具脱节。
- 运行 `npm run build` 确认无编译错误；若动了示例行为，可本地执行 `npm run example`（需有效 API key 才能走完整对话）。

## 可选：可视化状态机

`createAgent.ts` 文件注释中提到了 Stately Studio / VS Code Stately 扩展；复杂图表优先在状态机侧保持可读，再接到 agent。
