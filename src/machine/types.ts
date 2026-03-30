import type { MachineDefinition } from "./machine.js";

/**
 * A named machine instance that can contribute tools and receive events.
 *
 * - `id` must be unique among all machines passed to an agent (e.g. "web", "robot").
 * - Machine-local tools (e.g. "fetch_url") are namespaced in the flat list as `id_toolName` (see `namespacedToolName` in `runtime.ts`).
 */
export type MachineSpec<TState extends string = string> = {
  id: string;
  machine: MachineDefinition<TState>;
};

/** Non-empty list of machines. */
export type MachineSpecs<TState extends string = string> = readonly [MachineSpec<TState>, ...MachineSpec<TState>[]];
