import type { AgentTool } from "../pi-agent/types.js";

/** Meta shape attached to state nodes that expose tools to the LLM */
export interface ToolPhaseMeta {
  tools: AgentTool[];
}

/**
 * Reads `tools` from the active state node's `meta` (via {@link MachineSnapshot.getMeta}).
 * When multiple regions have meta, returns the first non-empty `tools` array.
 */
export function toolsFromMeta(snapshot: { getMeta(): Record<string, unknown> }): AgentTool[] {
  const meta = snapshot.getMeta();
  for (const m of Object.values(meta)) {
    if (m && typeof m === "object" && "tools" in m) {
      const t = (m as ToolPhaseMeta).tools;
      if (Array.isArray(t) && t.length > 0) return t;
    }
  }
  return [];
}
