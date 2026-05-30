# Worker `onStop` Closure Pattern

How the `create` handler wires up `activeWorkers` cleanup when `createAndStartFSMWorker` is called, and why the alternative of passing the map directly has drawbacks.

---

## The pattern in use: closure over a mutable variable

```ts
// fsm.handlers.ts — create handler
const controller = new AbortController();
let instanceId: string | null = null;

const fsm_instance = await createAndStartFSMWorker(
  deps,
  input_fsm_name,
  input_fsm_version,
  matchedModule ?? {},
  input_fsm_context,
  undefined,
  controller.signal,
  () => { if (instanceId) delete activeWorkers[instanceId]; },  // onStop
);

if (fsm_instance) {
  instanceId = fsm_instance.fsm_instance_id;         // assigned here
  activeWorkers[instanceId] = { lock: true, controller };
}
```

`instanceId` is `null` when the closure is created, but that is safe. The closure captures a **reference** to the variable — not its value at creation time. The closure body only executes when the worker loop eventually stops, well after `instanceId` has been assigned.

### Execution timeline

```
1. instanceId = null                            declared, null

2. createAndStartFSMWorker(..., onStop) called
   └─ createFsmInstanceFromName()               creates the DB row, returns instance
   └─ startFSMWorkerWithDBLock()                acquires DB lock, fires worker async
   └─ returns fsm_instance                      synchronously back to handler

3. instanceId = fsm_instance.fsm_instance_id   assigned in handler

4. activeWorkers[instanceId] = { ... }         registered in handler

        ... time passes, worker processes events ...

5. worker loop exits → onStop() fires
   └─ closure reads instanceId                 now holds the real id (step 3)
   └─ delete activeWorkers[instanceId]         cleans up correctly
```

### The guard handles the failure path

If `createFsmInstanceFromName` fails, `fsm_instance` is `null` and the handler returns early. `instanceId` stays `null`, nothing is registered in `activeWorkers`, and the `if (instanceId)` check in `onStop` makes the callback a no-op — no crash, no dangling entry.

---

## Alternative: pass the full `activeWorkers` map into the function

This approach would have `createAndStartFSMWorker` accept and mutate the handler's map directly:

```ts
// Hypothetical alternative
const fsm_instance = await createAndStartFSMWorker(
  deps,
  input_fsm_name,
  input_fsm_version,
  matchedModule ?? {},
  input_fsm_context,
  activeWorkers,   // handler passes its own map
  controller,
);
// function internally does: activeWorkers[instanceId] = { lock: true, controller }
```

### Drawbacks

**Leaky abstraction.** The worker function would need to know the `FsmWorkerEntry` shape (`{ lock: boolean; controller: AbortController }`) and import that type. A utility function now depends on the internal structure of its caller.

**Same anti-pattern as `activeLocks`.** This is exactly what was removed from `startFSMWorkerWithDBLock`. The function mutates caller state via a reference parameter, making data flow implicit — the caller can't tell from the return value alone what the function did to its map.

**Tight coupling.** If `FsmWorkerEntry` gains new fields, the worker function must change too, even though the change is purely about handler-level bookkeeping.

**Partial registration is unavoidable anyway.** The handler must still hold `controller` to call `entry.controller.abort()` from the `stop` handler. Since the handler can't escape owning the controller, having the function write the map entry is redundant — the handler would still need a post-call step. The closure pattern makes this single responsibility explicit: the function starts the worker, the handler owns the map.
