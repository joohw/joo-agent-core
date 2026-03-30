import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default root: `join(homedir(), ".joo-agent-core")` — layout from {@link resolveJooAgentDirs}. */
export function defaultJooAgentRoot(): string {
  return join(homedir(), ".joo-agent-core");
}

/** Subdirectory under the joo-agent root for persisted sessions (JSON files). */
export const JOO_AGENT_SESSIONS_DIR = "sessions" as const;

/** Subdirectory under the joo-agent root for skill assets (e.g. Markdown); not read by {@link createFileSessionStore}. */
export const JOO_AGENT_SKILLS_DIR = "skills" as const;

export interface JooAgentResolvedDirs {
  readonly rootDir: string;
  readonly sessionsDir: string;
  readonly skillsDir: string;
}

/** Resolves the `sessions` and `skills` paths under `rootDir` without creating them. */
export function resolveJooAgentDirs(rootDir: string): JooAgentResolvedDirs {
  return {
    rootDir,
    sessionsDir: join(rootDir, JOO_AGENT_SESSIONS_DIR),
    skillsDir: join(rootDir, JOO_AGENT_SKILLS_DIR),
  };
}

/**
 * Ensures `sessions` and `skills` exist under `rootDir` (recursive mkdir).
 */
export async function ensureJooAgentDirs(rootDir: string): Promise<JooAgentResolvedDirs> {
  const dirs = resolveJooAgentDirs(rootDir);
  await mkdir(dirs.sessionsDir, { recursive: true });
  await mkdir(dirs.skillsDir, { recursive: true });
  return dirs;
}
