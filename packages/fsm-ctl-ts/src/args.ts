import { parseArgs } from "@std/cli/parse-args";
import { usageError } from "./exit.ts";
import { type OutputFormat, parseOutputFormat } from "./output.ts";

/** Flags most commands share; each command opts into the ones it uses. */
export type CommonFlag = "db" | "api" | "output";

type Spec = {
  string?: string[];
  boolean?: string[];
  alias?: Record<string, string>;
  common?: CommonFlag[];
};

export type ParsedArgs = {
  /** Positionals after the noun: verb first. */
  positionals: string[];
  flags: Record<string, string | boolean | undefined>;
  help: boolean;
  output: OutputFormat;
  dbUrl?: string;
  url?: string;
  apiKey?: string;
  profile?: string;
};

/**
 * parseArgs plus what every pgfsmctl command needs: `-h/--help`, the common
 * flags it opts into (`db`: -d/--db-url, --profile; `api`: --url, --api-key,
 * --profile; `output`: -o/--output),
 * and unknown options rejected as a usage error (exit 2) instead of
 * silently ignored. `help` is the command's help text, printed with the error.
 */
export function parseCommandArgs(
  argv: string[],
  spec: Spec,
  help: string,
): ParsedArgs {
  const common = spec.common ?? [];
  const strings = [...(spec.string ?? [])];
  const alias: Record<string, string> = { h: "help", ...(spec.alias ?? {}) };
  if (common.includes("db")) {
    strings.push("db-url");
    alias.d = "db-url";
  }
  if (common.includes("api")) strings.push("url", "api-key");
  if (common.includes("db") || common.includes("api")) strings.push("profile");
  if (common.includes("output")) {
    strings.push("output");
    alias.o = "output";
  }
  const known = new Set([
    ...strings,
    ...(spec.boolean ?? []),
    "help",
    ...Object.keys(alias),
  ]);

  const args = parseArgs(argv, {
    string: strings,
    boolean: ["help", ...(spec.boolean ?? [])],
    alias,
    unknown: (arg: string) => {
      if (!arg.startsWith("-")) return true;
      const name = arg.replace(/^-+/, "").split("=")[0];
      if (known.has(name)) return true;
      throw usageError(`Unknown option: ${arg}`, help);
    },
  });

  const flags: ParsedArgs["flags"] = {};
  for (const [k, v] of Object.entries(args)) {
    if (k !== "_" && (typeof v === "string" || typeof v === "boolean")) {
      flags[k] = v;
    }
  }
  return {
    positionals: args._.map(String),
    flags,
    help: Boolean(args.help),
    output: common.includes("output")
      ? parseOutputFormat(args.output as string | undefined)
      : "table",
    dbUrl: args["db-url"] as string | undefined,
    url: args.url as string | undefined,
    apiKey: args["api-key"] as string | undefined,
    profile: args.profile as string | undefined,
  };
}

/** The verb, checked against the noun's verbs (usage error otherwise). */
export function verbOf<V extends string>(
  noun: string,
  positionals: string[],
  verbs: readonly V[],
  help: string,
): V {
  const verb = positionals[0];
  if (verb === undefined) {
    throw usageError(`${noun} needs a verb: ${verbs.join(", ")}`, help);
  }
  if (!(verbs as readonly string[]).includes(verb)) {
    throw usageError(`Unknown ${noun} verb: ${verb}`, help);
  }
  return verb as V;
}
