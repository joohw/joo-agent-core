# AGENTS.md — joo-agent-core


## 项目是什么

**joo-agent-core** 在 [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core) 之上，用内置 **阶段状态机**（`MachineDefinition` / `createMachine`）按阶段切换 **可用工具列表**，使 agent 在不同状态只暴露对应 `AgentTool`。


## 目录与职责

| 路径 | 说明 |
|------|------|
| `src/agent/createAgent.ts` | 将可选阶段机与 `Agent` 绑定：`setTools`、`beforeToolCall`、按状态机合并工具列表（工具名在 base + 多机间须唯一） |
| `src/agent/index.ts` | 对外统一入口 `Agent(...)`（覆盖/增强 pi-agent），并透出 `createAgent` 与类型 |
| `src/machine/types.ts` | machine 相关类型（`MachineSpec` / `MachineSpecs`） |
| `src/machine/machine.ts` | 轻量 FSM：`initial` + `states` + `on`（`event.type` → 下一状态） |
| `src/machine/metaHelpers.ts` | 例如从 `getMeta()` 解析 `tools`（常用于 `resolveTools`） |
| `src/machine/runtime.ts` | 多机注册、工具扁平化、`send` / `subscribeToolsChanged` |
| `src/event/eventBus.ts` | 通用事件总线（见下「事件总线」） |
| `src/index.ts` | 公共 API 聚合导出 |
| `test/example.ts` | 可运行示例：宠物养成状态机 + Kimi For Coding（`kimi-coding`） |

状态机切换工具时，`subscribeToolsChanged` 会调用 `setTools`（**替换** `Agent` 内部的 tools 数组）。`Agent` 循环在每次发起 LLM 请求和每次准备工具调用前，用当前的 `getTools()` 写回 `context.tools`，否则同一次 `prompt` 里下一轮仍会带上旧工具列表。

### 事件总线

`createEventBus` 是通用工具，本包不再额外定义 `state_change` 一类状态事件。对 UI 更新建议优先依赖 `agent.subscribe` 的 `AgentEvent`，或在需要时主动读取 `actors?.get(id)?.getSnapshot()`。

修改对外 API 时同步更新 `package.json` 的 `exports` 与 `src/index.ts`（及子路径 `agent` / `machine` / `event`）。

## 环境与运行

- **Node**：`>=20`（见 `package.json` `engines`）。
- **构建**：`npm run build`（`tsc` 输出到 `dist/`）。
- **示例**：`npm run example`（即 `tsx test/example.ts`）。

### pi-ai 环境变量（按所用 provider 设置）

示例 `test/example.ts` 仅使用 **Kimi For Coding**：在 `.env` 中设置 `KIMI_API_KEY`（与 Moonshot 开放平台 `api.moonshot.cn` 的密钥可能不是同一套，以 Kimi For Coding 控制台为准）。

其他厂商见 `node_modules/@mariozechner/pi-ai/README.md` 的 **Environment Variables (Node.js only)**。

未设置 `KIMI_API_KEY` 时，`test/example.ts` 会 **不调用真实 API**，仅打印阶段机初始状态与工具名后退出。

## TypeScript 约定

- **`module` / `moduleResolution`**：`NodeNext` —— 源码中 import 路径需带 **`.js` 后缀**（指向编译后的 `.js`），与现有文件一致。
- **`strict`**：保持开启；新增代码需通过类型检查。
- 公共类型与实现放在 `src/`，避免在无要求时新增根目录杂项文件。

## 改动时的注意点

- **只改任务所需文件**；不要顺带大段重构无关模块。
- 工具与阶段机联动时，确认 `resolveTools` / `deriveEventFromTool` 与各 `state.meta.tools` 一致，避免状态与可用工具脱节。
- 运行 `npm run build` 确认无编译错误；若动了示例行为，可本地执行 `npm run example`（需有效 API key 才能走完整对话）。

## 可选：可视化

复杂流程可在文档或注释里用表格列出「状态 → 事件 → 下一状态」，与 `MachineDefinition` 对齐即可。
