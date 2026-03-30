import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSessionData, SessionStore } from "./sessionStore.js";
import { ensureJooAgentDirs, resolveJooAgentDirs } from "../agent/paths.js";

const SAFE_SESSION_ID = /^[a-zA-Z0-9._-]+$/;

function assertSafeSessionId(sessionId: string): void {
  if (!sessionId || sessionId === "." || sessionId === ".." || !SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`Invalid sessionId: must match ${SAFE_SESSION_ID}`);
  }
}

function isAgentSessionData(value: unknown): value is AgentSessionData {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.sessionId === "string" &&
    typeof o.updatedAt === "number" &&
    Array.isArray(o.messages)
  );
}

/**
 * File-backed {@link SessionStore}: one JSON file per session under `{rootDir}/sessions/{sessionId}.json`.
 * On first `load` / `save` / `list`, {@link ensureJooAgentDirs} runs so `sessions` and `skills` both exist.
 */
export function createFileSessionStore(rootDir: string): SessionStore {
  const { sessionsDir } = resolveJooAgentDirs(rootDir);
  let ensureOnce: Promise<void> | undefined;

  const ensure = async () => {
    if (!ensureOnce) ensureOnce = ensureJooAgentDirs(rootDir).then(() => undefined);
    await ensureOnce;
  };

  return {
    async load(sessionId: string): Promise<AgentSessionData | null> {
      assertSafeSessionId(sessionId);
      await ensure();
      const path = join(sessionsDir, `${sessionId}.json`);
      try {
        const raw = await readFile(path, "utf8");
        const parsed: unknown = JSON.parse(raw) as unknown;
        if (!isAgentSessionData(parsed) || parsed.sessionId !== sessionId) {
          return null;
        }
        return parsed;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        throw e;
      }
    },

    async save(sessionId: string, data: AgentSessionData): Promise<void> {
      assertSafeSessionId(sessionId);
      if (data.sessionId !== sessionId) {
        throw new Error("Session data sessionId does not match save key");
      }
      await ensure();
      const path = join(sessionsDir, `${sessionId}.json`);
      await writeFile(path, JSON.stringify(data), "utf8");
    },

    async list(): Promise<string[]> {
      await ensure();
      const names = await readdir(sessionsDir);
      return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length));
    },
  };
}
