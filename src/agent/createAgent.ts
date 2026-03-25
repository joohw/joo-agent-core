import {
  Agent,
  type AgentContext,
  type AgentEvent,
  type AgentOptions,
  type AgentTool,
  type AgentToolResult,
} from "../pi-agent/index.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "../pi-agent/types.js";
import { validateToolArguments } from "@mariozechner/pi-ai";
import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";
import {
  type ActorOptions,
  type AnyStateMachine,
  type EventFromLogic,
  type SnapshotFrom,
} from "xstate";
import type { Actor } from "xstate";
import { compact } from "../compact/index.js";
import { createMachineRuntime, type MachineRuntime } from "../machine/runtime.js";
import type { MachineSpec, MachineSpecs } from "../machine/types.js";
import type { AgentSessionData, SessionStore } from "../session/sessionStore.js";

/**
 * Integrates `pi-agent` with an XState machine so `agent.setTools` follows the chart.
 *
 * **Visualization** (pick one):
 * - [Stately Studio](https://stately.ai/registry) — import the machine, edit and simulate visually
 * - VS Code extension **"Stately"** — diagram + inspect from your repo
 * - `import { toDirectedGraph } from "xstate/graph"` — build a graph structure for custom UIs
 *
 * Machine-driven tool gating is handled internally; subscribe to {@link AgentEvent} via {@link Agent.subscribe}.
 */

export interface CreateAgentWithXStateMachineHooks<TMachine extends AnyStateMachine> {
  /**
   * Map an about-to-run tool call to an XState event (e.g. `{ type: "gather_start" }`).
   * Only sent if `snapshot.can(event)` is true.
   *
   * This is useful for "real-time" UI state updates while a long-running tool is executing.
   */
  deriveEventFromToolStart?: (ctx: BeforeToolCallContext) => EventFromLogic<TMachine> | undefined;
  /**
   * Map a finished tool call to an XState event (e.g. `{ type: "gather_done" }`).
   * Only sent if `snapshot.can(event)` is true.
   */
  deriveEventFromTool?: (ctx: AfterToolCallContext) => EventFromLogic<TMachine> | undefined;
}

export interface CreateAgentWithXStateMachineArgs<TMachine extends AnyStateMachine> {
  agentOptions: AgentOptions;
  /**
   * Optional machine(s). When provided, all machines are started concurrently.
   *
   * - Prefer `machine` for a single machine.
   * - Pass an array for multiple machines.
   */
  machine?: MachineSpec<TMachine> | MachineSpecs<TMachine>;
  /** Which tools the model may call in this snapshot — often {@link toolsFromMeta}. */
  resolveTools: (snapshot: SnapshotFrom<TMachine>, machineId?: string) => AgentTool[];
  /** Passed to {@link createActor} (e.g. `input` for machines that require it). */
  actorOptions?: ActorOptions<TMachine>;
  hooks?: CreateAgentWithXStateMachineHooks<TMachine>;
  /**
   * Optional persistence: load/save `messages` (+ optional `systemPrompt`) via {@link SessionStore}.
   * When set, {@link createAgent} returns a `Promise` (see overloads).
   */
  sessionStore?: SessionStore;
  /** Omit to start a new session id; provide to resume or overwrite that id. */
  sessionId?: string;
  /** Default: true when `sessionStore` is set. */
  persistSystemPrompt?: boolean;
  /**
   * When restoring from store, prefer stored `systemPrompt` over `agentOptions.initialState.systemPrompt`.
   * Default: false.
   */
  restoreSystemPrompt?: boolean;
  /** Default: `["message_end","tool_execution_end"]` when `sessionStore` is set. */
  autoSaveOn?: Array<"message_end" | "tool_execution_end">;
}

/** Result of {@link AgentWithXStateMachine.runManualTool} (UI / WebSocket 手动调工具). */
export type ManualToolRunResult =
  | {
      ok: true;
      toolName: string;
      toolCallId: string;
      result: AgentToolResult<unknown>;
      isError: boolean;
    }
  | { ok: false; error: string; blocked?: boolean };

export interface AgentWithXStateMachine<TMachine extends AnyStateMachine> {
  readonly agent: Agent;
  /** Present when machine(s) are configured. */
  readonly actor?: Actor<TMachine>;
  /** Present when machine(s) are configured. */
  readonly actors?: ReadonlyMap<string, Actor<TMachine>>;
  /** Machine runtime (tool gating, routing, event broadcast). */
  readonly machineRuntime: MachineRuntime<TMachine>;
  /** Send an event; tool list updates via subscription when the transition applies. */
  send(event: EventFromLogic<TMachine>): void;
  /**
   * 与模型调工具同一路径：`beforeToolCall`（含状态内工具白名单）、`execute`、`afterToolCall`（含 `deriveEventFromTool`）。
   * `params` 为 JSON 对象，需符合该工具 TypeBox schema。
   */
  runManualTool(args: {
    name: string;
    params: unknown;
    signal?: AbortSignal;
  }): Promise<ManualToolRunResult>;
}

/** When {@link CreateAgentWithXStateMachineArgs.sessionStore} is set, {@link createAgent} resolves to this. */
export interface AgentWithSession<TMachine extends AnyStateMachine> extends AgentWithXStateMachine<TMachine> {
  readonly sessionId: string;
  readonly sessionStore: SessionStore;
  loadSession(sessionId: string): Promise<AgentSessionData | null>;
  saveSession(): Promise<void>;
}

function stateValueKey(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

type CreateAgentArgs<TMachine extends AnyStateMachine> = CreateAgentWithXStateMachineArgs<TMachine>;

export function createAgent<TMachine extends AnyStateMachine>(
  args: CreateAgentArgs<TMachine> & { sessionStore?: undefined }
): AgentWithXStateMachine<TMachine>;
export function createAgent<TMachine extends AnyStateMachine>(
  args: CreateAgentArgs<TMachine> & { sessionStore: SessionStore }
): Promise<AgentWithSession<TMachine>>;
export function createAgent<TMachine extends AnyStateMachine>(
  args: CreateAgentArgs<TMachine>
): AgentWithXStateMachine<TMachine> | Promise<AgentWithSession<TMachine>> {
  if (args.sessionStore) {
    return createAgentWithStore(args as CreateAgentArgs<TMachine> & { sessionStore: SessionStore });
  }
  return createAgentSync(args);
}

function createAgentSync<TMachine extends AnyStateMachine>(
  args: CreateAgentArgs<TMachine>
): AgentWithXStateMachine<TMachine> {
  const { agentOptions, resolveTools, actorOptions, hooks } = args;
  const baseTools: AgentTool[] = Array.isArray(agentOptions.initialState?.tools)
    ? (agentOptions.initialState?.tools as AgentTool[])
    : [];
  const machineRuntime = createMachineRuntime<TMachine>({
    machine: args.machine as MachineSpec<TMachine> | MachineSpecs<TMachine> | undefined,
    actorOptions,
    resolveTools: (snapshot, machineId) => resolveTools(snapshot as SnapshotFrom<TMachine>, machineId),
    baseTools,
  });

  const guardBefore = async (
    ctx: BeforeToolCallContext,
    signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> => {
    const user = await agentOptions.beforeToolCall?.(ctx, signal);
    if (user?.block) return user;
    if (!machineRuntime.isToolAllowed(ctx.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${ctx.toolCall.name}" is not available in current machines (${machineRuntime.formatStates()}).`,
      };
    }

    const startEv = hooks?.deriveEventFromToolStart?.(ctx);
    if (startEv !== undefined) {
      machineRuntime.send(startEv);
    }
    return undefined;
  };

  const mergedAfter = async (
    ctx: AfterToolCallContext,
    signal?: AbortSignal
  ): Promise<AfterToolCallResult | undefined> => {
    const userResult = await agentOptions.afterToolCall?.(ctx, signal);
    if (ctx.isError) return userResult;

    const ev = hooks?.deriveEventFromTool?.(ctx);
    if (ev !== undefined) {
      machineRuntime.send(ev);
    }
    return userResult;
  };

  const mergedTransformContext: AgentOptions["transformContext"] = async (messages, signal) => {
    let out = messages;
    try {
      if (agentOptions.transformContext) {
        out = await agentOptions.transformContext(out, signal);
      }
    } catch {
      out = messages;
    }
    try {
      return compact(out);
    } catch {
      return out;
    }
  };

  const agent = new Agent({
    ...agentOptions,
    initialState: {
      ...agentOptions.initialState,
      tools: machineRuntime.getTools(),
    },
    beforeToolCall: guardBefore,
    afterToolCall: mergedAfter,
    transformContext: mergedTransformContext,
  });

  function makeManualAssistantMessage(tc: ToolCall): AssistantMessage {
    return {
      role: "assistant",
      content: [tc],
      api: "manual",
      provider: "manual",
      model: "manual",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    } as AssistantMessage;
  }

  async function runManualTool(args: {
    name: string;
    params: unknown;
    signal?: AbortSignal;
  }): Promise<ManualToolRunResult> {
    const { name, params, signal } = args;
    const entry = machineRuntime.getToolEntry(name);
    if (!entry) {
      return { ok: false, error: `Tool "${name}" is not available in the current state.` };
    }
    const tool = entry.tool;

    const toolCallId = `manual-${randomUUID()}`;
    const rawArgs =
      params !== undefined && params !== null && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : ({} as Record<string, unknown>);

    const toolCall = {
      type: "toolCall",
      id: toolCallId,
      name,
      arguments: rawArgs,
    } as ToolCall;

    const assistantMessage = makeManualAssistantMessage(toolCall);

    let validatedArgs: unknown;
    try {
      validatedArgs = validateToolArguments(tool, toolCall);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const context: AgentContext = {
      systemPrompt: agent.state.systemPrompt,
      messages: agent.state.messages,
      tools: agent.state.tools,
    };

    const beforeResult = await guardBefore(
      {
        assistantMessage,
        toolCall,
        args: validatedArgs,
        context,
      },
      signal
    );
    if (beforeResult?.block) {
      return {
        ok: false,
        error: beforeResult.reason ?? "Tool execution was blocked",
        blocked: true,
      };
    }

    let result: AgentToolResult<unknown>;
    let isError: boolean;
    try {
      result = await entry.execute(toolCallId, validatedArgs, signal);
      isError = false;
    } catch (e) {
      result = {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        details: {},
      };
      isError = true;
    }

    const afterResult = await mergedAfter(
      {
        assistantMessage,
        toolCall,
        args: validatedArgs,
        result,
        isError,
        context,
      },
      signal
    );

    let finalResult = result;
    let finalIsError = isError;
    if (afterResult) {
      finalResult = {
        content: afterResult.content ?? result.content,
        details: afterResult.details ?? result.details,
      };
      finalIsError = afterResult.isError ?? isError;
    }

    return {
      ok: true,
      toolName: name,
      toolCallId,
      result: finalResult,
      isError: finalIsError,
    };
  }

  return {
    agent,
    ...(machineRuntime.actor ? { actor: machineRuntime.actor } : {}),
    ...(machineRuntime.actors ? { actors: machineRuntime.actors } : {}),
    machineRuntime,
    runManualTool,
    send(event: EventFromLogic<TMachine>) {
      machineRuntime.send(event);
    },
  };
}

async function createAgentWithStore<TMachine extends AnyStateMachine>(
  args: CreateAgentArgs<TMachine> & { sessionStore: SessionStore }
): Promise<AgentWithSession<TMachine>> {
  const store = args.sessionStore;
  const sessionId = args.sessionId ?? randomUUID();
  const persistSystemPrompt = args.persistSystemPrompt ?? true;
  const restoreSystemPrompt = args.restoreSystemPrompt ?? false;
  const autoSaveOn = args.autoSaveOn ?? ["message_end", "tool_execution_end"];
  const autoSaveSet = new Set(autoSaveOn);

  let restored: AgentSessionData | null = null;
  try {
    restored = await store.load(sessionId);
  } catch {
    restored = null;
  }

  const restoredMessages = restored?.messages;
  const restoredSystemPrompt = restored?.systemPrompt;

  const core = createAgentSync({
    ...args,
    agentOptions: {
      ...args.agentOptions,
      initialState: {
        ...args.agentOptions.initialState,
        ...(restoreSystemPrompt && restoredSystemPrompt !== undefined
          ? { systemPrompt: restoredSystemPrompt }
          : {}),
        ...(Array.isArray(restoredMessages) ? { messages: restoredMessages } : {}),
      },
    },
  });

  async function saveSession(): Promise<void> {
    const data: AgentSessionData = {
      version: 1,
      sessionId,
      updatedAt: Date.now(),
      messages: core.agent.state.messages,
      ...(persistSystemPrompt ? { systemPrompt: core.agent.state.systemPrompt } : {}),
    };
    await store.save(sessionId, data);
  }

  core.agent.subscribe((ev) => {
    if (ev.type === "message_end" && autoSaveSet.has("message_end")) void saveSession();
    if (ev.type === "tool_execution_end" && autoSaveSet.has("tool_execution_end")) void saveSession();
  });

  const runManualToolWithSave = async (a: {
    name: string;
    params: unknown;
    signal?: AbortSignal;
  }) => {
    const r = await core.runManualTool(a);
    if (autoSaveSet.size > 0) void saveSession();
    return r;
  };

  return {
    ...core,
    runManualTool: runManualToolWithSave,
    sessionId,
    sessionStore: store,
    loadSession: (id: string) => store.load(id),
    saveSession,
  };
}
