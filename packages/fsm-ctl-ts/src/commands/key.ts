import { getLogger } from "@logtape/logtape";
import { apiRequest } from "../api-client.ts";
import { resolveApiTarget } from "../api-target.ts";
import { parseCommandArgs, verbOf } from "../args.ts";
import { usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { KEY_ONCE_WARNING, parseKeyRole } from "../key-role.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { printList, printRecord } from "../output.ts";

const logger = getLogger([CTL_CATEGORY, "key"]);

const HELP = `pgfsmctl key — API keys, through the REST API (SPEC-009 §2–3)

USAGE
  ${CLI_INVOCATION} key create --name <name> --role admin|operator [options]
  ${CLI_INVOCATION} key list [options]
  ${CLI_INVOCATION} key revoke <id-or-name> [options]

  Needs an admin key and an API running with --enable-admin-api. The very
  first admin key can't come from here: mint it DB-direct with
  \`${CLI_INVOCATION} db key create\`.

VERBS
  create   Create a key and print it once (only its hash is stored)
  list     Every key, newest first: name, role, prefix, last use, revocation
  revoke   Revoke a live key by id or name (exit 4 if none matches)

OPTIONS
      --name <name>       Key name (create; unique)
      --role <role>       admin or operator (create)
      --url <url>         API base URL incl. its path prefix, e.g. http://localhost:9999/fsm
      --api-key <key>     Admin key (else --profile, PGFSM_API_KEY, current profile)
      --profile <name>    Use this profile's url and api_key
  -o, --output <fmt>      table (default), json or ids
  -h, --help              Show this help

EXIT CODES
  2 bad flags or no API target, 3 key rejected (401/403), 4 not found
  (also: admin API not enabled on the server)
`;

type KeyRow = {
  id: string;
  name: string;
  role: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export async function keyCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {
    string: ["name", "role"],
    common: ["api", "output"],
  }, HELP);
  if (args.help) return console.log(HELP);

  const verb = verbOf(
    "key",
    args.positionals,
    ["create", "list", "revoke"],
    HELP,
  );
  // Validate arguments before resolving the target, so usage errors don't
  // depend on configuration.
  let createBody: { name: string; role: string } | undefined;
  if (verb === "create") {
    const name = args.flags.name;
    if (typeof name !== "string" || name === "") {
      throw usageError("key create needs --name", HELP);
    }
    createBody = { name, role: parseKeyRole(args.flags.role, HELP) };
  }
  const idOrName = args.positionals[1];
  if (verb === "revoke" && !idOrName) {
    throw usageError("key revoke needs a key id or name", HELP);
  }

  const target = await resolveApiTarget(args);
  if (!target) {
    throw usageError(
      "No API: pass --url, set PGFSM_URL, or select a profile with a url (pgfsmctl config set <name> --url <url>).",
      HELP,
    );
  }

  switch (verb) {
    case "create": {
      const { data } = await apiRequest<
        { data: KeyRow & { key: string } }
      >(target, "POST", "/admin/keys", createBody);
      logger.warning(KEY_ONCE_WARNING);
      return printRecord(
        {
          id: data.id,
          name: data.name,
          role: data.role,
          prefix: data.prefix,
          key: data.key,
        },
        args.output,
        { id: (r) => r.id },
      );
    }
    case "list": {
      const { data } = await apiRequest<{ data: KeyRow[] }>(
        target,
        "GET",
        "/admin/keys",
      );
      return printList(data, args.output, {
        columns: [
          "name",
          "role",
          "prefix",
          "created_at",
          "last_used_at",
          "revoked_at",
        ],
        id: (r) => r.id,
      });
    }
    case "revoke": {
      await apiRequest(
        target,
        "DELETE",
        `/admin/keys/${encodeURIComponent(idOrName!)}`,
      );
      logger.info("Revoked API key {idOrName}", { idOrName });
      return printRecord({ key: idOrName!, revoked: true }, args.output, {
        id: (r) => r.key,
      });
    }
  }
}
