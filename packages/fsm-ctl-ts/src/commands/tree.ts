// The command tree, shared by `--help` (tiers) and `completion`. Keep in step
// with the command modules: cli.test.ts checks every noun here has --help.

export type Tier = "DB-direct" | "local";

export type NounSpec = {
  tier: Tier;
  /** Verbs, or sub-nouns mapping to their verbs (`db cron register`). */
  verbs: string[] | Record<string, string[]>;
  flags: string[];
};

const DB_FLAGS = ["--db-url", "--profile", "--output", "--help"];

export const COMMAND_TREE: Record<string, NounSpec> = {
  db: {
    tier: "DB-direct",
    verbs: { cron: ["register", "unregister", "status"] },
    flags: ["--schedule", ...DB_FLAGS],
  },
  fsm: { tier: "DB-direct", verbs: ["load"], flags: DB_FLAGS },
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
