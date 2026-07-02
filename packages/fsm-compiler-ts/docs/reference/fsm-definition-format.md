# FSM Definition Format

An FSM definition is a JSON file (`fsm.json`) placed in a versioned folder
inside a plugin root. It describes the state machine's states, transitions,
guards, actions, delays, and actor invocations. The compiler validates it and
generates TypeScript stubs from it.

The format is derived from XState 5's internal JSON representation. An
`xstate-fsm.json` (XState 5-compatible) is generated alongside `fsm.json` for
tooling.

## Top-level structure

```json
{
  "id": "(machine)",
  "key": "(machine)",
  "type": "compound",
  "version": "v01",
  "context": {},
  "initial": { ... },
  "states": { ... },
  "on": { ... }
}
```

| Field     | Type                         | Description                                            |
| --------- | ---------------------------- | ------------------------------------------------------ |
| `id`      | string                       | Machine identifier — typically `"(machine)"`           |
| `key`     | string                       | Same as `id`                                           |
| `type`    | `"compound"` \| `"parallel"` | Root must be `compound` or `parallel`                  |
| `version` | string                       | Version string matching the folder name (e.g. `"v01"`) |
| `context` | object                       | Initial context shape                                  |
| `initial` | InitialTransition            | Which state to enter on creation                       |
| `states`  | object                       | Map of state key → State node                          |

## State node types

### Atomic state

A leaf state with no children.

```json
{
  "id": "(machine).idle",
  "key": "idle",
  "type": "atomic",
  "on": {
    "Start": [
      {
        "target": ["#(machine).running"],
        "source": "#(machine).idle",
        "eventType": "Start",
        "actions": [{ "type": "logStart" }]
      }
    ]
  },
  "entry": [],
  "exit": [],
  "invoke": []
}
```

### Compound state

A state with sub-states and an initial sub-state.

```json
{
  "type": "compound",
  "initial": {
    "target": ["#(machine).parent.child"],
    "source": "#(machine).parent",
    "actions": []
  },
  "states": { ... }
}
```

### Parallel state

All child states are active simultaneously.

```json
{
  "type": "parallel",
  "states": {
    "regionA": { ... },
    "regionB": { ... }
  }
}
```

### Final state

Terminal — reaching it sets `fsm_instance_status` to `"done"` and triggers
parent notification if a parent queue is present.

```json
{
  "type": "final"
}
```

## Transitions

```json
{
  "eventType": "Submit",
  "source": "#(machine).idle",
  "target": ["#(machine).running"],
  "actions": [{ "type": "logSubmit" }],
  "cond": { "type": "isValid" }
}
```

| Field       | Description                                                              |
| ----------- | ------------------------------------------------------------------------ |
| `eventType` | The event name that triggers this transition                             |
| `source`    | Fully-qualified source state ID                                          |
| `target`    | Array of target state IDs (usually one)                                  |
| `actions`   | Side effects to run on this transition                                   |
| `cond`      | Optional guard — if present, must return true for the transition to fire |

## Actions

Actions are referenced by name in `entry`, `exit`, and transition `actions`
arrays. The compiler resolves each name against `typescript/actions/index.ts`.

```json
{ "type": "myActionName" }
```

Special built-in actions (not resolved against user code):

- `xstate.raise` — raise an internal event
- `xstate.cancel` — cancel a delayed event

## Guards

```json
{ "type": "myGuardName" }
```

Referenced in `cond` on transitions. Resolved against
`typescript/guards/index.ts`.

## Delays

Delays schedule an event after a duration. Reference them by name; the compiler
generates a delay function in `typescript/delays/index.ts`.

```json
{ "type": "delayMyDelay" }
```

The function must return the delay in milliseconds.

## Invocations (actors)

Invocations spawn actors when a state is entered. Each invocation has a `src`
(the actor name), a `fsmType`, and optionally a `fsmVersion`.

```json
{
  "invoke": [
    {
      "type": "xstate.invoke",
      "id": "myActor",
      "src": "myActorName",
      "fsmType": "promise",
      "fsmVersion": "v01"
    }
  ]
}
```

| `fsmType`       | Meaning                                          |
| --------------- | ------------------------------------------------ |
| `promise`       | A new async function — one queue per invocation  |
| `sharedPromise` | An async function shared across FSM instances    |
| `fsm`           | A child FSM — gets its own instance and queue    |
| `sharedFsm`     | A child FSM sharing a queue with other instances |

When the actor completes, XState sends `xstate.done.actor.<id>` back to the
parent FSM. On error: `xstate.error.actor.<id>`.

## InitialTransition

```json
{
  "target": ["#(machine).idle"],
  "source": "#(machine)",
  "actions": []
}
```

## Versioning

FSM definitions live in versioned sub-folders (`v01`, `v02`, …). Version folders
are immutable once deployed — create a new folder for each revision. Existing
FSM instances continue running against the version they were created on.
