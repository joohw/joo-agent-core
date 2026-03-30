import {
  Agent as Core,
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
import { compact } from "../compact/index.js";
import type { EventBus } from "../event/eventBus.js";
import { STATE_CHANGE_EVENT, type AgentPhaseEventBus } from "../event/stateChange.js";
import { createMachineRuntime, type MachineRuntime } from "../machine/runtime.js";
import type { MachineEvent, MachineHandle, MachineSnapshot } from "../machine/machine.js";
import type { MachineSpec, MachineSpecs } from "../machine/types.js";
import type { AgentSessionData, SessionStore } from "../session/sessionStore.js";

/**
 * Hooks for mapping tool calls to phase events (see {@link AgentConfig.hooks}).
 */
export interface Hooks<TEvent extends MachineEvent = MachineEvent> {
  deriveEventFromToolStart?: (ctx: BeforeToolCallContext) => TEvent | undefined;
  deriveEventFromTool?: (ctx: AfterToolCallContext) => TEvent | undefined;
}

/**
 * Options for {@link Agent} / {@link createAgent}.
 */
export interface AgentConfig<TState extends string = string, TEvent extends MachineEvent = MachineEvent> {
  agentOptions: AgentOptions;
  machine?: MachineSpec<TState> | MachineSpecs<TState>;
  resolveTools: (snapshot: MachineSnapshot, machineId?: string) => AgentTool[];
  hooks?: Hooks<TEvent>;
  /**
   * When set, each phase machine state transition emits {@link STATE_CHANGE_EVENT}
   * with {@link MachineStateChangePayload} (see `src/event/stateChange.ts`).
   */
  eventBus?: EventBus<AgentPhaseEventBus>;
  sessionStore?: SessionStore;
  sessionId?: string;
  persistSystemPrompt?: boolean;
  restoreSystemPrompt?: boolean;
  autoSaveOn?: Array<"message_end" | "tool_execution_end">;
}

/** Result of {@link Agent.runManualTool}. */
export type ManualToolResult =
  | {
      ok: true;
      toolName: string;
      toolCallId: string;
      result: AgentToolResult<unknown>;
      isError: boolean;
    }
  | { ok: false; error: string; blocked?: boolean };

/**
 * Created agent: LLM {@link agent} plus optional phase machine handles and {@link runtime}.
 */
export interface Agent<TEvent extends MachineEvent = MachineEvent> {
  /** pi-agent instance (prompt, subscribe, state, …). */
  readonly agent: Core;
  readonly phase?: MachineHandle;
  readonly phases?: ReadonlyMap<string, MachineHandle>;
  readonly runtime: MachineRuntime;
  /** Same reference as {@link AgentConfig.eventBus} when provided. */
  readonly eventBus?: EventBus<AgentPhaseEventBus>;
  send(event: TEvent): void;
  runManualTool(args: {
    name: string;
    params: unknown;
    signal?: AbortSignal;
  }): Promise<ManualToolResult>;
}

/** When `sessionStore` is set on {@link AgentConfig}, {@link Agent} resolves to this. */
export interface SessionAgent<TEvent extends MachineEvent = MachineEvent> extends Agent<TEvent> {
  readonly sessionId: string;
  readonly sessionStore: SessionStore;
  loadSession(sessionId: string): Promise<AgentSessionData | null>;
  saveSession(): Promise<void>;
}

type Config<TState extends string, TEvent extends MachineEvent> = AgentConfig<TState, TEvent>;

export function Agent<TState extends string = string, TEvent extends MachineEvent = MachineEvent>(
  args: Config<TState, TEvent> & { sessionStore?: undefined }
): Agent<TEvent>;
export function Agent<TState extends string = string, TEvent extends MachineEvent = MachineEvent>(
  args: Config<TState, TEvent> & { sessionStore: SessionStore }
): Promise<SessionAgent<TEvent>>;
export function Agent<TState extends string = string, TEvent extends MachineEvent = MachineEvent>(
  args: Config<TState, TEvent>
): Agent<TEvent> | Promise<SessionAgent<TEvent>> {
  if (args.sessionStore) {
    return createWithSession(args as Config<TState, TEvent> & { sessionStore: SessionStore });
  }
  return buildAgent(args);
}

/** Alias of {@link Agent}. */
export const createAgent = Agent;

function buildAgent<TState extends string, TEvent extends MachineEvent>(args: Config<TState, TEvent>): Agent<TEvent> {
  const { agentOptions, resolveTools, hooks, eventBus } = args;
  const baseTools: AgentTool[] = Array.isArray(agentOptions.initialState?.tools)
    ? (agentOptions.initialState?.tools as AgentTool[])
    : [];
  const runtime = createMachineRuntime<TState>({
    machine: args.machine,
    resolveTools: (snapshot, machineId) => resolveTools(snapshot as MachineSnapshot, machineId),
    baseTools,
    onMachineStateChange: eventBus
      ? (payload) => {
          eventBus.emit(STATE_CHANGE_EVENT, payload);
        }
      : undefined,
  });

  const guardBefore = async (
    ctx: BeforeToolCallContext,
    signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> => {
    const user = await agentOptions.beforeToolCall?.(ctx, signal);
    if (user?.block) return user;
    if (!runtime.isToolAllowed(ctx.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${ctx.toolCall.name}" is not available in current machines (${runtime.formatStates()}).`,
      };
    }

    const startEv = hooks?.deriveEventFromToolStart?.(ctx);
    if (startEv !== undefined) {
      runtime.send(startEv);
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
      runtime.send(ev);
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

  const llm = new Core({
    ...agentOptions,
    initialState: {
      ...agentOptions.initialState,
      tools: runtime.getTools(),
    },
    beforeToolCall: guardBefore,
    afterToolCall: mergedAfter,
    transformContext: mergedTransformContext,
  });

  runtime.subscribeToolsChanged(() => {
    llm.setTools(runtime.getTools());
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
  }): Promise<ManualToolResult> {
    const { name, params, signal } = args;
    const entry = runtime.getToolEntry(name);
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
      systemPrompt: llm.state.systemPrompt,
      messages: llm.state.messages,
      tools: llm.state.tools,
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
    agent: llm,
    ...(runtime.phase ? { phase: runtime.phase } : {}),
    ...(runtime.phases ? { phases: runtime.phases } : {}),
    ...(eventBus ? { eventBus } : {}),
    runtime,
    runManualTool,
    send(event: TEvent) {
      runtime.send(event);
    },
  };
}

async function createWithSession<TState extends string, TEvent extends MachineEvent>(
  args: Config<TState, TEvent> & { sessionStore: SessionStore }
): Promise<SessionAgent<TEvent>> {
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

  const core = buildAgent({
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
