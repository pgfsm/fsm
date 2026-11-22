# Commercial licence

The pgfsm engine is licensed under the
[GNU Affero General Public License v3.0 only](LICENSES/AGPL-3.0-only.txt)
(AGPL-3.0-only). The engine is:

- **fsm_core**: `packages/database-src/` (SQL, migrations, install SQL, PGXN
  bundle), except its contract files, and `packages/database-src-extension/`
- **`@pgfsm/api`**: `packages/fsm-api-ts/`
- **The Activity Gateway** (`@pgfsm/async-worker-gateway`):
  `packages/fsm-async-worker-gateway-ts/`

Everything else, including the worker SDKs, `@pgfsm/sync-worker`, `@pgfsm/db`,
the CLIs and fsm_core's contract files (the FSM JSON schemas and `generated/`),
is Apache-2.0. You don't need a commercial licence to use those parts. See
[LICENSE](LICENSE) for the full mapping.

## Who needs one

Most users don't. The AGPL lets you run, evaluate and self-host the unmodified
engine. Its extra obligation applies if you **modify** the engine and let users
interact with it over a network: you must then offer them the source of your
modified version (AGPL-3.0 §13).

A commercial licence is for organisations that can't accept the AGPL, for
example because their policy bans AGPL software, or because they want to modify
the engine without publishing their changes.

## Getting one

The engine is available under a commercial licence as an alternative to the
AGPL. Terms and pricing aren't published. Contact us to discuss them:

**Contact:** [licensing@pgfsm.dev](mailto:licensing@pgfsm.dev). Tell us your
organisation, which engine components you use and how you deploy them.

The [Contributor License Agreement](CLA.md) is what makes this dual licensing
possible: it lets the project offer contributed code under both licences.
