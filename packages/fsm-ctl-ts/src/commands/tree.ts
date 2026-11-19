// The command tree, shared by `--help` (tiers) and `completion`. Keep in step
// with the command modules: cli.test.ts checks every noun here has --help.

export type Tier = "API" | "local";

export type NounSpec = {
  tier: Tier;
  /** Verbs, or sub-nouns mapping to their verbs. */
  verbs: string[] | Record<string, string[]>;
  flags: string[];
};

const API_FLAGS = ["--url", "--api-key", "--profile", "--output", "--help"];

export const COMMAND_TREE: Record<string, NounSpec> = {
  fsm: {
    tier: "API",
    verbs: ["load", "list", "get"],
    flags: ["--fsm-name", "--fsm-version", ...API_FLAGS],
  },
  key: {
    tier: "API",
    verbs: ["create", "list", "revoke"],
    flags: ["--name", "--role", ...API_FLAGS],
  },
  instance: {
    tier: "API",
    verbs: ["create", "resume", "send", "stop", "list", "get"],
    flags: [
      "--queue-name",
      "--fsm-name",
      "--fsm-version",
      "--input",
      "--event-type",
      "--event-data",
      "--status",
      "--limit",
      ...API_FLAGS,
    ],
  },
  scheduler: {
    tier: "API",
    verbs: ["status", "register"],
    flags: ["--schedule", ...API_FLAGS],
  },
  config: {
    tier: "local",
    verbs: ["set", "use", "list", "show"],
    flags: [
      "--url",
      "--api-key-stdin",
      "--use",
      "--output",
      "--help",
    ],
  },
  completion: {
    tier: "local",
    verbs: ["bash", "zsh", "fish"],
    flags: ["--help"],
  },
  version: { tier: "local", verbs: [], flags: ["--output", "--help"] },
};

/** First-level words after a noun: verbs, or sub-nouns. */
export const firstWords = (noun: string): string[] => {
  const v = COMMAND_TREE[noun].verbs;
  return Array.isArray(v) ? v : Object.keys(v);
};
