import type { AnyStateMachine } from "xstate";
import type { SessionStore } from "../session/index.js";
import type { MachineSpec, MachineSpecs } from "../machine/types.js";
import {
  createAgent,
  type AgentWithSession,
  type AgentWithXStateMachine,
  type CreateAgentWithXStateMachineArgs,
  type CreateAgentWithXStateMachineHooks,
  type ManualToolRunResult,
} from "./createAgent.js";

type BaseAgentArgs<TMachine extends AnyStateMachine> = Omit<
  CreateAgentWithXStateMachineArgs<TMachine>,
  "sessionStore"
> & {
  machine?: MachineSpec<TMachine> | MachineSpecs<TMachine>;
};

export type AgentArgs<TMachine extends AnyStateMachine> = BaseAgentArgs<TMachine> & {
  sessionStore?: undefined;
};

export type AgentArgsWithSession<TMachine extends AnyStateMachine> = BaseAgentArgs<TMachine> & {
  sessionStore: SessionStore;
};

/**
 * Unified Agent constructor for this package.
 * Extends the base pi-agent behavior with machine/session integration.
 */
export function Agent<TMachine extends AnyStateMachine>(
  args: AgentArgs<TMachine>
): AgentWithXStateMachine<TMachine>;
export function Agent<TMachine extends AnyStateMachine>(
  args: AgentArgsWithSession<TMachine>
): Promise<AgentWithSession<TMachine>>;
export function Agent<TMachine extends AnyStateMachine>(
  args: AgentArgs<TMachine> | AgentArgsWithSession<TMachine>
): AgentWithXStateMachine<TMachine> | Promise<AgentWithSession<TMachine>> {
  if ("sessionStore" in args && args.sessionStore) {
    return createAgent(args as CreateAgentWithXStateMachineArgs<TMachine> & { sessionStore: SessionStore });
  }
  return createAgent(args as CreateAgentWithXStateMachineArgs<TMachine> & { sessionStore?: undefined });
}

export {
  createAgent,
  type AgentWithSession,
  type AgentWithXStateMachine,
  type CreateAgentWithXStateMachineArgs,
  type CreateAgentWithXStateMachineHooks,
  type ManualToolRunResult,
};
