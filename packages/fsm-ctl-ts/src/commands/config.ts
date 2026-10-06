import { getLogger } from "@logtape/logtape";
import { parseCommandArgs, verbOf } from "../args.ts";
import {
  configPath,
  type Profile,
  readConfig,
  readCredentials,
  writeConfig,
  writeCredentials,
} from "../config.ts";
import { urlPassword } from "../db-target.ts";
import { notFound, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { printList, printRecord } from "../output.ts";

const logger = getLogger([CTL_CATEGORY, "config"]);

const VERBS = ["set", "use", "list", "show"] as const;

const HELP =
  `pgfsmctl config — named targets (profiles), local only (SPEC-009 §5)

USAGE
  ${CLI_INVOCATION} config set <name> [--db-url <url>] [--url <url>]
                                 [--db-password-stdin | --api-key-stdin] [--use]
  ${CLI_INVOCATION} config use <name>
  ${CLI_INVOCATION} config list [-o table|json|ids]
  ${CLI_INVOCATION} config show [<name>] [-o table|json|ids]

VERBS
  set    Create or update a profile. Only the given fields change.
  use    Make a profile the current one.
  list   Every profile; * marks the current one.
  show   One profile (default: the current one). Secrets are never shown,
         only whether they're set.

OPTIONS
      --db-url <url>          Postgres URL for DB-direct commands, WITHOUT a password
      --url <url>             pgfsm REST API URL (API-tier commands, #473)
      --db-password-stdin     Read the database password from stdin
      --api-key-stdin         Read the API key from stdin
      --use                   With set: also make it the current profile
  -o, --output <fmt>          table (default), json or ids
  -h, --help                  Show this help

FILES
  config.yaml       profiles (url, db_url) and the current one; no secrets
  credentials.json  passwords and API keys, mode 0600
  In \$PGFSM_CONFIG_DIR, else the OS config dir + /pgfsm (currently:
  ${configPath().replace(/\/config\.yaml$/, "")}).

SELECTING A PROFILE
  --profile <name> or \$PGFSM_PROFILE beat \$PGFSM_DB_URL/\$DATABASE_URL (and
  ./.env); the current profile (\`config use\`) is used only when neither those
  nor --db-url is set.

EXAMPLES
  echo "\$PGPASSWORD" | ${CLI_INVOCATION} config set prod \\
      --db-url postgresql://fsm_admin_login@db.internal:5432/postgres --db-password-stdin
  ${CLI_INVOCATION} config use prod
  ${CLI_INVOCATION} db cron status --profile staging
`;

async function readStdin(what: string): Promise<string> {
  // A plain loop rather than `new Response(stdin)`, which doesn't type-check
  // under the npm build's Node shims.
  const decoder = new TextDecoder();
  let raw = "";
  for await (const chunk of Deno.stdin.readable) {
    raw += decoder.decode(chunk, { stream: true });
  }
  const text = (raw + decoder.decode()).trim();
  if (!text) throw usageError(`${what}: nothing on stdin`, HELP);
  return text;
}

export async function configCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    string: ["db-url", "url"],
    boolean: ["db-password-stdin", "api-key-stdin", "use"],
    common: ["output"],
  }, HELP);
  if (args.help) return console.log(HELP);

  const verb = verbOf("config", args.positionals, VERBS, HELP);
  const name = args.positionals[1];
  const config = await readConfig();

  switch (verb) {
    case "set": {
      if (!name) throw usageError("config set needs a profile name", HELP);
      const dbUrl = args.flags["db-url"] as string | undefined;
      const url = args.flags.url as string | undefined;
      const dbPasswordStdin = args.flags["db-password-stdin"] === true;
      const apiKeyStdin = args.flags["api-key-stdin"] === true;
      if (dbPasswordStdin && apiKeyStdin) {
        throw usageError(
          "--db-password-stdin and --api-key-stdin both read stdin; set them in two calls",
          HELP,
        );
      }
      if (!dbUrl && !url && !dbPasswordStdin && !apiKeyStdin) {
        throw usageError(
          "config set needs at least one of --db-url, --url, --db-password-stdin, --api-key-stdin",
          HELP,
        );
      }
      if (dbUrl !== undefined) {
        try {
          new URL(dbUrl);
        } catch {
          throw usageError(`--db-url is not a URL: ${dbUrl}`, HELP);
        }
        if (urlPassword(dbUrl)) {
          // A password on the command line lands in shell history, and the
          // profile file must never hold one.
          throw usageError(
            "--db-url must not contain a password: pass it with --db-password-stdin",
            HELP,
          );
        }
      }

      const profile: Profile = {
        ...config.profiles[name],
        ...(dbUrl !== undefined ? { db_url: dbUrl } : {}),
        ...(url !== undefined ? { url } : {}),
      };
      config.profiles[name] = profile;
      if (args.flags.use === true || !config.current) config.current = name;
      await writeConfig(config);

      if (dbPasswordStdin || apiKeyStdin) {
        const secret = await readStdin(
          dbPasswordStdin ? "--db-password-stdin" : "--api-key-stdin",
        );
        const creds = await readCredentials();
        creds.profiles[name] = {
          ...creds.profiles[name],
          ...(dbPasswordStdin ? { db_password: secret } : { api_key: secret }),
        };
        await writeCredentials(creds);
      }
      logger.info("Profile {name} saved to {path}", {
        name,
        path: configPath(),
      });
      return printRecord(await describe(name), args.output, {
        id: (r) => r.name,
      });
    }

    case "use": {
      if (!name) throw usageError("config use needs a profile name", HELP);
      if (!config.profiles[name]) {
        throw notFound(`No profile named ${JSON.stringify(name)}`);
      }
      config.current = name;
      await writeConfig(config);
      logger.info("Current profile: {name}", { name });
      return printRecord(await describe(name), args.output, {
        id: (r) => r.name,
      });
    }

    case "list": {
      const rows = await Promise.all(
        Object.keys(config.profiles).sort().map(describe),
      );
      return printList(rows, args.output, {
        columns: ["current", "name", "db_url", "url", "db_password", "api_key"],
        id: (r) => r.name,
      });
    }

    case "show": {
      const target = name ?? config.current;
      if (!target) {
        throw notFound(
          `No current profile (${CLI_INVOCATION} config use <name>)`,
        );
      }
      if (!config.profiles[target]) {
        throw notFound(`No profile named ${JSON.stringify(target)}`);
      }
      return printRecord(await describe(target), args.output, {
        id: (r) => r.name,
      });
    }
  }
}

/** A profile as shown to the user: secrets reduced to set/unset. */
async function describe(name: string) {
  const [config, creds] = await Promise.all([readConfig(), readCredentials()]);
  const p = config.profiles[name] ?? {};
  const s = creds.profiles[name] ?? {};
  return {
    current: config.current === name ? "*" : "",
    name,
    db_url: p.db_url ?? "",
    url: p.url ?? "",
    db_password: s.db_password ? "set" : "",
    api_key: s.api_key ? "set" : "",
  };
}
