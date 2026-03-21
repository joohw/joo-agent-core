import {
  Agent,
  type AgentEvent,
  type AgentOptions,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { AfterToolCallContext, BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";
import {
  createActor,
  type ActorOptions,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EventFromLogic,
  type SnapshotFrom,
  type StateValue,
} from "xstate";
import type { Actor } from "xstate";
import type { EventBus, EventUnsubscribe } from "../event/eventBus.js";

function asMachineSnapshot<TMachine extends AnyStateMachine>(s: SnapshotFrom<TMachine>): AnyMachineSnapshot {
  return s as AnyMachineSnapshot;
}

/**
 * Integrates `@mariozechner/pi-agent-core` with an XState machine so `agent.setTools` follows the chart.
 *
 * **Visualization** (pick one):
 * - [Stately Studio](https://stately.ai/registry) — import the machine, edit and simulate visually
 * - VS Code extension **"Stately"** — diagram + inspect from your repo
 * - `import { toDirectedGraph } from "xstate/graph"` — build a graph structure for custom UIs
 *
 * **State + agent in one listener:** {@link AgentWithXStateMachine.subscribe}. Or use
 * {@link AgentWithXStateMachine.subscribeStateChange} / optional `eventBus` — still not mixed into `AgentEvent`.
 */
/** Emitted on XState value changes; unrelated to pi-agent streaming events. */
export interface StateChangePayload {
  from: StateValue;
  to: StateValue;
}

/** Event name for {@link StateChangePayload} on {@link CreateAgentWithXStateMachineArgs.eventBus}. */
export const STATE_CHANGE_EVENT = "state_change" as const;

/**
 * Single stream merging pi-agent {@link AgentEvent} with XState {@link StateChangePayload}.
 * Use {@link AgentWithXStateMachine.subscribe} instead of wiring `agent.subscribe` + `subscribeStateChange` by hand.
 */
export type AgentWithMachineEvent =
  | { kind: "agent"; event: AgentEvent }
  | { kind: "state_change"; payload: StateChangePayload };

export interface CreateAgentWithXStateMachineHooks<TMachine extends AnyStateMachine> {
  onTransition?: (args: { from: StateValue; to: StateValue }) => void;
  /**
   * Map a finished tool call to an XState event (e.g. `{ type: "gather_done" }`).
   * Only sent if `snapshot.can(event)` is true.
   */
  deriveEventFromTool?: (ctx: AfterToolCallContext) => EventFromLogic<TMachine> | undefined;
}

export interface CreateAgentWithXStateMachineArgs<TMachine extends AnyStateMachine> {
  agentOptions: AgentOptions;
  machine: TMachine;
  /** Which tools the model may call in this snapshot — often {@link toolsFromMeta}. */
  resolveTools: (snapshot: SnapshotFrom<TMachine>) => AgentTool[];
  /** Passed to {@link createActor} (e.g. `input` for machines that require it). */
  actorOptions?: ActorOptions<TMachine>;
  hooks?: CreateAgentWithXStateMachineHooks<TMachine>;
  /**
   * Optional bus: emits {@link STATE_CHANGE_EVENT} with {@link StateChangePayload} on each XState value change.
   * Merge with your own events: `createEventBus<{ state_change: StateChangePayload } & YourEvents>()`.
   */
  eventBus?: EventBus<{ state_change: StateChangePayload }>;
}

export interface AgentWithXStateMachine<TMachine extends AnyStateMachine> {
  readonly agent: Agent;
  readonly actor: Actor<TMachine>;
  /** Send an event; tool list updates via subscription when the transition applies. */
  send(event: EventFromLogic<TMachine>): void;
  /**
   * Subscribe to XState value changes — **not** part of pi-agent `agent.subscribe` streaming events.
   * Order per transition: `hooks.onTransition`, then these listeners, then `eventBus.emit` (if set).
   * Delivery is async (microtask) so it runs after `tool_execution_end` when the transition was
   * caused inside `afterToolCall` (see pi-agent contract for hook vs. `tool_execution_end`).
   */
  subscribeStateChange(handler: (payload: StateChangePayload) => void): EventUnsubscribe;
  /**
   * Subscribe to both {@link AgentEvent} (`kind: "agent"`) and state transitions (`kind: "state_change"`).
   * For {@link AgentEvent} only, use {@link AgentWithXStateMachine.agent.subscribe}.
   * Unsubscribe removes both underlying subscriptions.
   */
  subscribe(handler: (event: AgentWithMachineEvent) => void): EventUnsubscribe;
}

function stateValueKey(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function createAgentWithXStateMachine<TMachine extends AnyStateMachine>(
  args: CreateAgentWithXStateMachineArgs<TMachine>
): AgentWithXStateMachine<TMachine> {
  const { agentOptions, machine, resolveTools, actorOptions, hooks, eventBus } = args;

  const stateChangeListeners = new Set<(payload: StateChangePayload) => void>();

  /**
   * Deliver state-change notifications after the current stack / awaited work in the agent loop.
   * When a transition is triggered from `afterToolCall`, that hook runs before `tool_execution_end`
   * is emitted; deferring keeps `state_change` / `eventBus` order aligned with pi-agent events
   * (listeners see `tool_execution_end` before `state_change`).
   */
  function notifyStateChange(payload: StateChangePayload): void {
    queueMicrotask(() => {
      hooks?.onTransition?.(payload);
      for (const h of [...stateChangeListeners]) {
        h(payload);
      }
      eventBus?.emit(STATE_CHANGE_EVENT, payload);
    });
  }

  const actor = createActor(machine, actorOptions);
  actor.start();

  const guardBefore = async (
    ctx: BeforeToolCallContext,
    signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> => {
    const user = await agentOptions.beforeToolCall?.(ctx, signal);
    if (user?.block) return user;
    const snap = asMachineSnapshot(actor.getSnapshot());
    const allowed = new Set(resolveTools(actor.getSnapshot()).map((t) => t.name));
    if (!allowed.has(ctx.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${ctx.toolCall.name}" is not available in state ${stateValueKey(snap.value)}.`,
      };
    }
    return undefined;
  };

  const mergedAfter: AgentOptions["afterToolCall"] = async (ctx, signal) => {
    const userResult = await agentOptions.afterToolCall?.(ctx, signal);
    if (ctx.isError) return userResult;

    const ev = hooks?.deriveEventFromTool?.(ctx);
    if (ev !== undefined) {
      const snap = asMachineSnapshot(actor.getSnapshot());
      if (snap.can(ev)) {
        actor.send(ev);
      }
    }
    return userResult;
  };

  const agent = new Agent({
    ...agentOptions,
    initialState: {
      ...agentOptions.initialState,
      tools: resolveTools(actor.getSnapshot()),
    },
    beforeToolCall: guardBefore,
    afterToolCall: mergedAfter,
  });

  let prevSnapshot = asMachineSnapshot(actor.getSnapshot());

  actor.subscribe((snapshot) => {
    const s = asMachineSnapshot(snapshot);
    const prevKey = stateValueKey(prevSnapshot.value);
    const nextKey = stateValueKey(s.value);
    if (prevKey !== nextKey) {
      notifyStateChange({ from: prevSnapshot.value, to: s.value });
    }
    prevSnapshot = s;
    agent.setTools(resolveTools(snapshot));
  });

  return {
    agent,
    actor,
    send(event: EventFromLogic<TMachine>) {
      actor.send(event);
    },
    subscribeStateChange(handler: (payload: StateChangePayload) => void): EventUnsubscribe {
      stateChangeListeners.add(handler);
      return () => {
        stateChangeListeners.delete(handler);
      };
    },
    subscribe(handler: (event: AgentWithMachineEvent) => void): EventUnsubscribe {
      const unsubAgent = agent.subscribe((event) => {
        handler({ kind: "agent", event });
      });
      const stateHandler = (payload: StateChangePayload) => {
        handler({ kind: "state_change", payload });
      };
      stateChangeListeners.add(stateHandler);
      return () => {
        unsubAgent();
        stateChangeListeners.delete(stateHandler);
      };
    },
  };
}
