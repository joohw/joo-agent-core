/**
 * Payload for {@link STATE_CHANGE_EVENT}: one configured machine transitioned.
 * `previousValue` / `nextValue` use the same string form as {@link MachineSnapshot.value}
 * (via runtime’s `stateValueKey` — typically the state id string).
 */
export interface MachineStateChangePayload {
  machineId: string;
  previousValue: string;
  nextValue: string;
}

/** Event name for {@link EventBus} when a phase machine’s state value changes. */
export const STATE_CHANGE_EVENT = "state_change" as const;

/**
 * Typical `EventBus` shape for {@link createAgent} when wiring `eventBus`.
 * Use: `createEventBus<AgentPhaseEventBus>()` or intersect with your own events.
 */
export type AgentPhaseEventBus = {
  [STATE_CHANGE_EVENT]: MachineStateChangePayload;
};
