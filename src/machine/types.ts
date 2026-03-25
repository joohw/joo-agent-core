import type { AnyStateMachine } from "xstate";

/**
 * A named machine instance that can contribute tools and receive events.
 *
 * - `id` must be unique among all machines passed to an agent (e.g. "web", "robot").
 * - Machine-local tools (e.g. "fetch_url") are namespaced to `${id}.${toolName}` in the flat tool list.
 */
export type MachineSpec<TMachine extends AnyStateMachine = AnyStateMachine> = {
  id: string;
  machine: TMachine;
};

/** Non-empty list of machines. */
export type MachineSpecs<TMachine extends AnyStateMachine = AnyStateMachine> = readonly [
  MachineSpec<TMachine>,
  ...MachineSpec<TMachine>[],
];

