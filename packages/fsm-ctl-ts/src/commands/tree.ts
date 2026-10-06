// The command tree, shared by `--help` (tiers) and `completion`. Keep in step
// with the command modules: cli.test.ts checks every noun here has --help.

export type Tier = "API" | "API or DB-direct" | "DB-direct" | "local";

export type NounSpec = {
  tier: Tier;
  /** Verbs, or sub-nouns mapping to their verbs (`db cron register`). */
  verbs: string[] | Record<string, string[]>;
  flags: string[];
};

const DB_FLAGS = ["--db-url", "--profile", "--output", "--help"];
const API_FLAGS = ["--url", "--api-key", "--profile", "--output", "--help"];

export const COMMAND_TREE: Record<string, NounSpec> = {
  db: {
    tier: "DB-direct",
    verbs: {
      cron: ["register", "unregister", "status"],
      key: ["create"],
    },
    flags: ["--schedule", "--name", "--role", ...DB_FLAGS],
  },
  fsm: {
    tier: "API or DB-direct",
    verbs: ["load"],
    flags: ["--url", "--api-key", ...DB_FLAGS],
  },
  key: {
    tier: "API",
    verbs: ["create", "list", "revoke"],
    flags: ["--name", "--role", ...API_FLAGS],
  },
  instance: {
    tier: "DB-direct",
    verbs: ["create", "resume", "send", "stop"],
    flags: [
      "--queue-name",
      "--fsm-name",
      "--fsm-version",
      "--input",
      "--event-type",
      "--event-data",
      ...DB_FLAGS,
    ],
  },
  scheduler: {
    tier: "DB-direct",
    verbs: ["run"],
    flags: [
      "--poll-interval",
      "--stale-threshold",
      "--db-url",
      "--profile",
      "--help",
    ],
  },
  config: {
    tier: "local",
    verbs: ["set", "use", "list", "show"],
    flags: [
      "--db-url",
      "--url",
      "--db-password-stdin",
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
