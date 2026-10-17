import { assertEquals } from "@std/assert";
import { orderEntryActions } from "../src/fsmlet/entry-actions.ts";

const entry = (type: string, fsm_order: number) => ({
  type,
  fsm_order,
  action_type: "entry",
});
const invoke = (type: string, fsm_order: number) => ({
  type,
  fsm_order,
  action_type: "invoke",
});
const initial = (type: string, fsm_order: number) => ({
  type,
  fsm_order,
  action_type: "initial",
});
const types = (actions: unknown[]) =>
  actions.map((a) => (a as { type: string }).type);

Deno.test("orderEntryActions runs each state's initial actions after its entry and invoke actions (#506)", () => {
  assertEquals(
    types(orderEntryActions(
      [
        entry("enterR", 1),
        entry("enterC", 2),
        invoke("xstate.invoke", 2),
        entry("enterX", 3),
      ],
      [initial("initR", 1), initial("initC", 2)],
    )),
    ["enterR", "initR", "enterC", "xstate.invoke", "initC", "enterX"],
  );
});

Deno.test("orderEntryActions puts children-first lists from older databases parents first", () => {
  assertEquals(
    types(orderEntryActions(
      [entry("enterX", 3), entry("enterC", 2), entry("enterR", 1)],
      [initial("initC", 2), initial("initR", 1)],
    )),
    ["enterR", "initR", "enterC", "initC", "enterX"],
  );
});

Deno.test("orderEntryActions keeps a state's own actions in order and tolerates missing lists", () => {
  assertEquals(
    types(orderEntryActions([entry("first", 2), entry("second", 2)], null)),
    ["first", "second"],
  );
  assertEquals(orderEntryActions(null, null), []);
});
