import { assertEquals } from "@std/assert";
import {
  type GuardRef,
  selectTransitions,
  type TransitionCandidate,
} from "../src/fsmlet/select-transitions.ts";

const t = (
  id: number,
  source: string,
  cond: TransitionCandidate["cond"] = null,
): TransitionCandidate => ({
  id,
  computed_sanitized_source_ltree: source,
  cond,
});
const ids = (selected: TransitionCandidate[]) => selected.map((c) => c.id);
/** Passes the guards named in `passing`, and records every guard it ran. */
const guards = (...passing: string[]) => {
  const ran: GuardRef[] = [];
  const evaluate = (guard: GuardRef) => {
    ran.push(guard);
    return Promise.resolve(passing.includes(guard.type));
  };
  return { ran, evaluate };
};

Deno.test("selectTransitions: a guarded pair with a fallback takes the guarded one when its guard passes (#510)", async () => {
  const g = guards("ok");
  assertEquals(
    ids(
      await selectTransitions(
        [t(1, "m.a", "ok"), t(2, "m.a")],
        ["m", "m.a"],
        g.evaluate,
      ),
    ),
    [1],
  );
});

Deno.test("selectTransitions: ...and the fallback when it doesn't", async () => {
  assertEquals(
    ids(
      await selectTransitions(
        [t(1, "m.a", "ok"), t(2, "m.a")],
        ["m", "m.a"],
        guards().evaluate,
      ),
    ),
    [2],
  );
});

Deno.test("selectTransitions: candidates are tried in definition order (by id), not as returned", async () => {
  assertEquals(
    ids(
      await selectTransitions(
        [t(7, "m.a"), t(3, "m.a")],
        ["m", "m.a"],
        guards().evaluate,
      ),
    ),
    [3],
  );
});

Deno.test("selectTransitions: a single guarded candidate whose guard fails is not taken", async () => {
  const g = guards();
  assertEquals(
    await selectTransitions([t(1, "m.a", "ok")], ["m", "m.a"], g.evaluate),
    [],
  );
  assertEquals(g.ran, [{ type: "ok" }]);
});

Deno.test("selectTransitions: an unguarded candidate is taken", async () => {
  assertEquals(
    ids(
      await selectTransitions([t(1, "m.a")], ["m", "m.a"], guards().evaluate),
    ),
    [1],
  );
});

Deno.test("selectTransitions: { type, params } guards get their params; booleans are themselves", async () => {
  const g = guards("ok");
  assertEquals(
    ids(
      await selectTransitions(
        [
          t(1, "m.a", false),
          t(2, "m.a", { type: "ok", params: { min: 3 } }),
        ],
        ["m", "m.a"],
        g.evaluate,
      ),
    ),
    [2],
  );
  assertEquals(g.ran, [{ type: "ok", params: { min: 3 } }]);
});

Deno.test("selectTransitions: the child's transition wins over the parent's", async () => {
  assertEquals(
    ids(
      await selectTransitions(
        [t(1, "m"), t(2, "m.a")],
        ["m", "m.a"],
        guards().evaluate,
      ),
    ),
    [2],
  );
});

Deno.test("selectTransitions: the parent's transition is taken when the child has none enabled", async () => {
  assertEquals(
    ids(
      await selectTransitions(
        [t(1, "m"), t(2, "m.a", "no")],
        ["m", "m.a"],
        guards().evaluate,
      ),
    ),
    [1],
  );
});

Deno.test("selectTransitions: one transition per parallel region, and the parallel state's only when no region has one", async () => {
  const active = ["r", "r.p", "r.p.a", "r.p.a.x", "r.p.b", "r.p.b.y"];
  assertEquals(
    ids(
      await selectTransitions(
        [t(1, "r.p"), t(2, "r.p.a.x"), t(3, "r.p.b.y"), t(4, "r.p.b.y")],
        active,
        guards().evaluate,
      ),
    ),
    [2, 3],
  );
  assertEquals(
    ids(
      await selectTransitions(
        [t(1, "r.p"), t(2, "r.p.a.x", "no")],
        active,
        guards().evaluate,
      ),
    ),
    [1],
  );
});

Deno.test("selectTransitions: a root id with dots is one state", async () => {
  assertEquals(
    ids(
      await selectTransitions(
        [t(1, "com.acme.m"), t(2, "com.acme.m.a")],
        ["com.acme.m", "com.acme.m.a"],
        guards().evaluate,
      ),
    ),
    [2],
  );
});

Deno.test("selectTransitions: nothing enabled selects nothing", async () => {
  assertEquals(
    await selectTransitions([], ["m", "m.a"], guards().evaluate),
    [],
  );
});
