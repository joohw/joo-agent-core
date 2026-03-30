/**
 * Minimal deterministic FSM: named states, `meta` per state, transitions keyed by `event.type`.
 * No external state-machine library.
 */

/** Event shape used with {@link MachineHandle.send} and {@link MachineHandle.can}. */
export type MachineEvent = { type: string };

export interface MachineSnapshot {
  /** Current state id. */
  value: string;
  /** Meta for the active state (wrapped so {@link toolsFromMeta} can read `tools`). */
  getMeta(): Record<string, unknown>;
}

export interface MachineHandle {
  getSnapshot(): MachineSnapshot;
  send(event: MachineEvent): void;
  can(event: MachineEvent): boolean;
  subscribe(listener: () => void): { unsubscribe: () => void };
}

export interface MachineStateConfig {
  /** Arbitrary data; typical use: `{ tools: AgentTool[] }` for {@link toolsFromMeta}. */
  meta?: Record<string, unknown>;
  /** Maps `event.type` → next state id. */
  on?: Record<string, string>;
}

export interface MachineDefinition<TState extends string = string> {
  initial: TState;
  states: Record<TState, MachineStateConfig>;
}

export function createMachine<TState extends string>(def: MachineDefinition<TState>): MachineHandle {
  let state: TState = def.initial;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const l of listeners) l();
  }

  return {
    getSnapshot(): MachineSnapshot {
      return {
        value: state,
        getMeta() {
          const node = def.states[state];
          return { current: node?.meta ?? {} };
        },
      };
    },
    can(event: MachineEvent): boolean {
      const next = def.states[state]?.on?.[event.type];
      return next !== undefined;
    },
    send(event: MachineEvent): void {
      const next = def.states[state]?.on?.[event.type];
      if (next !== undefined) {
        state = next as TState;
        notify();
      }
    },
    subscribe(listener: () => void): { unsubscribe: () => void } {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
  };
}
