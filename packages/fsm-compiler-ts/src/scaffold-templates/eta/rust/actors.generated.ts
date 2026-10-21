// AUTO-GENERATED from actors.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  '// <%~ it.label %>: <%~ it.name %>\n\n/// How many invokes of this actor one worker runs at once. Above 1, the\n/// handler runs on several threads at once: shared state needs a `Mutex` or\n/// atomics. Delivery is at-least-once, so the handler must also be\n/// idempotent: the same invoke can arrive more than once.\npub const MAX_CONCURRENCY: u32 = 1;\n\n#[allow(non_snake_case)]\npub fn <%~ it.fnName %>(\n    input: serde_json::Value,\n    _token: pgfsm_async_worker_sdk::CancellationToken,\n) -> serde_json::Value {\n    // <%~ it.todo %>\n    // _token is cancelled when the gateway cancels this invoke (e.g. its FSM\n    // state exited): check _token.is_cancelled() between steps.\n    serde_json::json!({ "input": input, "msg": "<%~ it.name %> actor invoked by <%~ it.lang %>" })\n}\n\n',
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
