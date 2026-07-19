/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: packages/database-src/fsm.machine.schema.v3.json
 * Regenerate with: deno task generate:fsm-types (run from packages/fsm-compiler-ts)
 */

export type ID = string;
export type AtomicStateNode = BaseStateNode & {
  type?: "atomic";
  entry?: ActionObject[];
  exit?: ActionObject[];
  invoke?: InvokeArray;
  on: TransitionsObject;
};
export type Order = number;
export type InvokeArray = InvokeObject[];
export type CompoundStateNode = BaseStateNode & {
  type?: "compound";
  entry?: ActionObject[];
  exit?: ActionObject[];
  initial?: InitialTransitionObject;
  invoke?: InvokeArray;
  on?: TransitionsObject;
  states: StatesObject;
};
export type ParallelStateNode = BaseStateNode & {
  type?: "parallel";
  entry?: ActionObject[];
  exit?: ActionObject[];
  invoke?: InvokeArray;
  on?: TransitionsObject;
  states: StatesObject;
};
export type HistoryStateNode = BaseStateNode & {
  type?: "history";
  history: "shallow" | "deep";
};
export type FinalStateNode = BaseStateNode & {
  type?: "final";
  data?: {
    [k: string]: unknown;
  };
};

export interface FsmMachineJson {
  id: ID;
  initial?: InitialTransitionObject;
  key: string;
  type: "compound" | "parallel";
  context?: {
    [k: string]: unknown;
  };
  states: StatesObject;
  on?: TransitionsObject;
  transitions?: TransitionObject[];
  entry?: ActionObject[];
  exit?: ActionObject[];
  order?: Order;
  invoke?: InvokeArray;
  version?: string;
}
export interface InitialTransitionObject {
  actions: ActionObject[];
  source: string;
  /**
   * @minItems 1
   */
  target: [string, ...string[]];
  eventType?: string | null;
}
export interface ActionObject {
  /**
   * The action type
   */
  type: string;
  /**
   * Required when type is xstate.raise or xstate.cancel
   */
  delayActionName?: string;
  /**
   * The event type for the delay action
   */
  delayActionEventType?: string;
  [k: string]: unknown;
}
export interface StatesObject {
  /**
   * This interface was referenced by `StatesObject`'s JSON-Schema definition
   * via the `patternProperty` "^.*$".
   */
  [k: string]:
    | AtomicStateNode
    | CompoundStateNode
    | ParallelStateNode
    | HistoryStateNode
    | FinalStateNode;
}
export interface BaseStateNode {
  id: string;
  key: string;
  type: "atomic" | "compound" | "parallel" | "final" | "history";
  order?: Order;
  /**
   * The description of the state node, in Markdown
   */
  description?: string;
}
export interface InvokeObject {
  type: string;
  id: string;
  src: string;
  /**
   * The type of the invoked service. promise for a new promise, sharedPromise for an existing promise but shared with other FSMs, and fsm for another finite state machine.
   */
  fsmType: "promise" | "sharedPromise" | "sharedFsm" | "fsm";
  /**
   * The version of the FSM being invoked, required if fsmType is fsm or sharedPromise
   */
  fsmVersion: string;
  /**
   * Language runtime that executes the invoked service. Defaults to typescript. Aligns with the actor folder convention (typescript/, python/, rust/, go/, llm/).
   */
  fsmLanguage?: "typescript" | "python" | "rust" | "go" | "llm";
}
export interface TransitionsObject {
  /**
   * This interface was referenced by `TransitionsObject`'s JSON-Schema definition
   * via the `patternProperty` "^.*$".
   */
  [k: string]: TransitionObject[];
}
export interface TransitionObject {
  actions: ActionObject[];
  /**
   * Legacy guard payload consumed by the PostgreSQL extension's transition loader (transition->'cond'). Not emitted by this compiler, which emits `guard` instead.
   */
  cond?: {
    [k: string]: unknown;
  };
  /**
   * Name of the guard function to evaluate for this transition.
   */
  guard?: string;
  /**
   * Delay identifier (xstate.after.* transitions) or duration in ms.
   */
  delay?: string | number;
  eventType: string;
  source: string;
  target: string[];
}
