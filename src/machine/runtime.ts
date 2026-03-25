import type { AgentTool, AgentToolResult } from "../pi-agent/types.js";
import { createActor, type ActorOptions, type AnyStateMachine, type EventFromLogic } from "xstate";
import type { Actor } from "xstate";
import type { MachineSpec, MachineSpecs } from "./types.js";

type ToolRegistryEntry =
  | {
      kind: "base";
      tool: AgentTool;
      execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
    }
  | {
      kind: "machine";
      machineId: string;
      localName: string;
      tool: AgentTool; // wrapped (namespaced) tool used for validation/metadata
      execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
    };

export interface MachineRuntime<TMachine extends AnyStateMachine> {
  actor?: Actor<TMachine>;
  actors?: ReadonlyMap<string, Actor<TMachine>>;
  /** Build flat tools: baseTools + machine tools (namespaced). */
  getTools(): AgentTool[];
  /** Whether a flat tool name is currently allowed. */
  isToolAllowed(toolName: string): boolean;
  /** Human-readable states string for errors. */
  formatStates(): string;
  /** Lookup a tool entry (for validation/execution). */
  getToolEntry(toolName: string): ToolRegistryEntry | undefined;
  /** Send an event to any machine that can accept it. */
  send(event: EventFromLogic<TMachine>): void;
  /** Subscribe to machine snapshot changes (used to refresh tools). */
  subscribeToolsChanged(handler: () => void): () => void;
}

function namespacedToolName(machineId: string, toolName: string): string {
  return `${machineId}.${toolName}`;
}

function wrapTool(machineId: string, tool: AgentTool): AgentTool {
  return {
    ...tool,
    name: namespacedToolName(machineId, tool.name),
    label: `${machineId}.${tool.label}`,
  };
}

function normalizeMachineSpecs<TMachine extends AnyStateMachine>(
  machine?: MachineSpec<TMachine> | MachineSpecs<TMachine>
): MachineSpec<TMachine>[] {
  if (!machine) return [];
  return Array.isArray(machine) ? [...(machine as MachineSpecs<TMachine>)] : [machine as MachineSpec<TMachine>];
}

function stateValueKey(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function createMachineRuntime<TMachine extends AnyStateMachine>(args: {
  machine?: MachineSpec<TMachine> | MachineSpecs<TMachine>;
  actorOptions?: ActorOptions<TMachine>;
  resolveTools: (snapshot: unknown, machineId?: string) => AgentTool[];
  baseTools?: AgentTool[];
}): MachineRuntime<TMachine> {
  const baseTools = Array.isArray(args.baseTools) ? args.baseTools : [];
  const machineSpecs = normalizeMachineSpecs(args.machine);

  const actors = new Map<string, Actor<TMachine>>();
  const machineIds: string[] = [];

  for (const m of machineSpecs) {
    if (!m?.id || typeof m.id !== "string") throw new Error("Each machine requires a string id.");
    if (actors.has(m.id)) throw new Error(`Duplicate machine id "${m.id}".`);
    const a = createActor(m.machine, args.actorOptions);
    a.start();
    actors.set(m.id, a);
    machineIds.push(m.id);
  }

  const actor = machineIds.length > 0 ? (actors.get(machineIds[0]) as Actor<TMachine>) : undefined;

  function getToolsByMachineId(machineId: string): AgentTool[] {
    const a = actors.get(machineId);
    if (!a) return [];
    return args.resolveTools(a.getSnapshot(), machineId);
  }

  function buildRegistry(): Map<string, ToolRegistryEntry> {
    const registry = new Map<string, ToolRegistryEntry>();

    for (const t of baseTools) {
      if (registry.has(t.name)) throw new Error(`Duplicate base tool name "${t.name}".`);
      registry.set(t.name, {
        kind: "base",
        tool: t,
        execute: (toolCallId, params, signal) => t.execute(toolCallId, params as never, signal),
      });
    }

    for (const machineId of machineIds) {
      const locals = getToolsByMachineId(machineId);
      const localNameSet = new Set<string>();
      const localByName = new Map<string, AgentTool>();
      for (const t of locals) {
        if (localNameSet.has(t.name)) {
          throw new Error(`Duplicate tool name "${t.name}" within machine "${machineId}".`);
        }
        localNameSet.add(t.name);
        localByName.set(t.name, t);
      }

      for (const localTool of locals) {
        const wrapped = wrapTool(machineId, localTool);
        if (registry.has(wrapped.name)) {
          throw new Error(`Duplicate tool name "${wrapped.name}" in flat tool registry.`);
        }
        registry.set(wrapped.name, {
          kind: "machine",
          machineId,
          localName: localTool.name,
          tool: wrapped,
          execute: async (toolCallId, params, signal) => {
            const t = localByName.get(localTool.name);
            if (!t) throw new Error(`Tool "${wrapped.name}" not found in machine "${machineId}".`);
            return await t.execute(toolCallId, params as never, signal);
          },
        });
      }
    }

    return registry;
  }

  function getTools(): AgentTool[] {
    return [...buildRegistry().values()].map((e) => e.tool);
  }

  function isToolAllowed(toolName: string): boolean {
    return buildRegistry().has(toolName);
  }

  function formatStates(): string {
    if (machineIds.length === 0) return "no machines";
    return machineIds
      .map((id) => {
        const a = actors.get(id);
        if (!a) return undefined;
        return `${id}:${stateValueKey((a.getSnapshot() as any).value)}`;
      })
      .filter((v): v is string => v !== undefined)
      .join(", ");
  }

  function getToolEntry(toolName: string): ToolRegistryEntry | undefined {
    return buildRegistry().get(toolName);
  }

  function send(event: EventFromLogic<TMachine>): void {
    if (actors.size === 0) return;
    for (const a of actors.values()) {
      const snap: any = a.getSnapshot();
      if (typeof snap?.can === "function" && snap.can(event)) {
        a.send(event as any);
      }
    }
  }

  function subscribeToolsChanged(handler: () => void): () => void {
    const unsubs: Array<() => void> = [];
    for (const id of machineIds) {
      const a = actors.get(id);
      if (!a) continue;
      const sub = a.subscribe(() => handler());
      unsubs.push(() => sub.unsubscribe());
    }
    return () => {
      for (const u of unsubs) u();
    };
  }

  return {
    actor,
    ...(actors.size > 0 ? { actors } : {}),
    getTools,
    isToolAllowed,
    formatStates,
    getToolEntry,
    send,
    subscribeToolsChanged,
  };
}

