import type { AgentMessage } from "../pi-agent/types.js";

/**
 * Minimal persisted session payload.
 *
 * Note: We persist only agent conversation state (systemPrompt + messages).
 * Phase machine state is intentionally not persisted here because restoring it
 * requires machine-specific snapshot wiring. If you need that, store it in your
 * own implementation alongside this payload.
 */
export interface AgentSessionData {
  /** Schema version for forward compatibility. */
  version: 1;
  sessionId: string;
  updatedAt: number;
  systemPrompt?: string;
  messages: AgentMessage[];
}

export interface SessionStore {
  /** Load a persisted session; return null if missing. */
  load(sessionId: string): Promise<AgentSessionData | null>;
  /** Persist a session payload (full overwrite). */
  save(sessionId: string, data: AgentSessionData): Promise<void>;
  /** Optional: list known session ids (e.g. for a UI). */
  list?(): Promise<string[]>;
}

