import type { MachineDefinition } from "../machine/machine.js";

/** 与 {@link skillMachine} 配套，传给 `createAgent({ machine: { id: SKILL_MACHINE_ID, machine: skillMachine } })`。 */
export const SKILL_MACHINE_ID = "skill" as const;

/** 内置 skill 工作流的状态 id。 */
export type SkillMachineState = "browsing" | "invoking";

/**
 * 内置 **skill** 阶段机：`browsing`（阅读说明：列出/阅读技能）↔ `invoking`（仅暴露所选技能的工具）。
 *
 * `meta.tools` 为空；请在 `resolveTools` 里按快照状态返回实际工具（例如浏览态的 `get_skills` / `read_skills` / `select_skill`，调用态的技能工具 + `return_to_browse`），并在 `hooks.deriveEventFromTool` 里把 `select_skill` / `return_to_browse` 映射为 `skill_chosen` / `browse`。
 */
export const skillMachine: MachineDefinition<SkillMachineState> = {
  initial: "browsing",
  states: {
    browsing: {
      meta: { tools: [] },
      on: { skill_chosen: "invoking" },
    },
    invoking: {
      meta: { tools: [] },
      on: { browse: "browsing" },
    },
  },
};
