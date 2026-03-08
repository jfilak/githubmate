import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

export interface PocConfig {
  workspaceRoot: string;
  agent: {
    command: "claude" | "opencode";
  };
}

const DEFAULT_CONFIG: PocConfig = {
  workspaceRoot: "./poc-workspaces",
  agent: {
    command: "claude",
  },
};

export function loadConfig(configPath?: string): PocConfig {
  if (!configPath) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as Partial<PocConfig>;

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    agent: {
      ...DEFAULT_CONFIG.agent,
      ...parsed.agent,
    },
  };
}
