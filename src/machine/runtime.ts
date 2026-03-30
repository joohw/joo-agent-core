import type { AgentTool, AgentToolResult } from "../pi-agent/types.js";
import {
  createMachine,
  type MachineDefinition,
  type MachineEvent,
  type MachineHandle,
} from "./machine.js";
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
      tool: AgentTool;
      execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
    };

export interface MachineRuntime {
  /** First configured machine (when multiple exist, prefer `phases.get(id)`). */
  phase?: MachineHandle;
  phases?: ReadonlyMap<string, MachineHandle>;
  /** Build flat tools: baseTools + machine tools (namespaced). */
  getTools(): AgentTool[];
  /** Whether a flat tool name is currently allowed. */
  isToolAllowed(toolName: string): boolean;
  /** Human-readable states string for errors. */
  formatStates(): string;
  /** Lookup a tool entry (for validation/execution). */
  getToolEntry(toolName: string): ToolRegistryEntry | undefined;
  /** Send an event to any machine that accepts it (`can` is true). */
  send(event: MachineEvent): void;
  /** Subscribe to machine snapshot changes (used to refresh tools). */
  subscribeToolsChanged(handler: () => void): () => void;
}

/**
 * Joins machine id and local tool name for the flat tool list.
 * Uses `__` (not `.`) so names stay valid for providers that reject dots in function names (e.g. Kimi).
 * Machine id and local tool name must not contain this substring.
 */
export const MACHINE_TOOL_NAMESPACE_SEP = "__" as const;

function assertValidMachineToolSegment(s: string, label: string): void {
  if (s.includes(MACHINE_TOOL_NAMESPACE_SEP)) {
    throw new Error(`${label} must not contain "${MACHINE_TOOL_NAMESPACE_SEP}": ${JSON.stringify(s)}`);
  }
}

export function namespacedToolName(machineId: string, toolName: string): string {
  assertValidMachineToolSegment(machineId, "Machine id");
  assertValidMachineToolSegment(toolName, "Tool name");
  return `${machineId}${MACHINE_TOOL_NAMESPACE_SEP}${toolName}`;
}

/**
 * Split a flat tool name back into machine id + local name. Tries longest machine ids first
 * so ids that share a prefix do not collide.
 */
export function parseNamespacedToolName(
  flatName: string,
  machineIds: readonly string[]
): { machineId: string; localName: string } | undefined {
  const sorted = [...machineIds].sort((a, b) => b.length - a.length);
  for (const id of sorted) {
    const prefix = `${id}${MACHINE_TOOL_NAMESPACE_SEP}`;
    if (flatName.startsWith(prefix)) {
      return { machineId: id, localName: flatName.slice(prefix.length) };
    }
  }
  return undefined;
}

function wrapTool(machineId: string, tool: AgentTool): AgentTool {
  return {
    ...tool,
    name: namespacedToolName(machineId, tool.name),
    label: `${machineId} · ${tool.label}`,
  };
}

function normalizeMachineSpecs<TState extends string>(
  machine?: MachineSpec<TState> | MachineSpecs<TState>
): MachineSpec<TState>[] {
  if (!machine) return [];
  return Array.isArray(machine) ? [...(machine as MachineSpecs<TState>)] : [machine as MachineSpec<TState>];
}

function stateValueKey(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function createMachineRuntime<TState extends string>(args: {
  machine?: MachineSpec<TState> | MachineSpecs<TState>;
  resolveTools: (snapshot: unknown, machineId?: string) => AgentTool[];
  baseTools?: AgentTool[];
}): MachineRuntime {
  const baseTools = Array.isArray(args.baseTools) ? args.baseTools : [];
  const machineSpecs = normalizeMachineSpecs(args.machine);

  const phases = new Map<string, MachineHandle>();
  const machineIds: string[] = [];

  for (const m of machineSpecs) {
    if (!m?.id || typeof m.id !== "string") throw new Error("Each machine requires a string id.");
    if (phases.has(m.id)) throw new Error(`Duplicate machine id "${m.id}".`);
    const handle = createMachine(m.machine as MachineDefinition<TState>);
    phases.set(m.id, handle);
    machineIds.push(m.id);
  }

  const phase = machineIds.length > 0 ? (phases.get(machineIds[0]) as MachineHandle) : undefined;

  function getToolsByMachineId(machineId: string): AgentTool[] {
    const a = phases.get(machineId);
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
        const a = phases.get(id);
        if (!a) return undefined;
        return `${id}:${stateValueKey(a.getSnapshot().value)}`;
      })
      .filter((v): v is string => v !== undefined)
      .join(", ");
  }

  function getToolEntry(toolName: string): ToolRegistryEntry | undefined {
    return buildRegistry().get(toolName);
  }

  function send(event: MachineEvent): void {
    if (phases.size === 0) return;
    for (const a of phases.values()) {
      if (a.can(event)) {
        a.send(event);
      }
    }
  }

  function subscribeToolsChanged(handler: () => void): () => void {
    const unsubs: Array<() => void> = [];
    for (const id of machineIds) {
      const a = phases.get(id);
      if (!a) continue;
      const sub = a.subscribe(() => handler());
      unsubs.push(() => sub.unsubscribe());
    }
    return () => {
      for (const u of unsubs) u();
    };
  }

  return {
    phase,
    ...(phases.size > 0 ? { phases } : {}),
    getTools,
    isToolAllowed,
    formatStates,
    getToolEntry,
    send,
    subscribeToolsChanged,
  };
}
