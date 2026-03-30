import type { MachineDefinition } from "./machine.js";

/**
 * A named machine instance that can contribute tools and receive events.
 *
 * - `id` must be unique among all machines passed to an agent (e.g. "web", "robot").
 * - Machine-local tools use their defined `name` in the flat list; names must be unique across base tools and all machines.
 */
export type MachineSpec<TState extends string = string> = {
  id: string;
  machine: MachineDefinition<TState>;
};

/** Non-empty list of machines. */
export type MachineSpecs<TState extends string = string> = readonly [MachineSpec<TState>, ...MachineSpec<TState>[]];
