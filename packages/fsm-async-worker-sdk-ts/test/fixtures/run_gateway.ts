// Test fixture: a SidecarGateway in its own process, so a test can SIGKILL it
// to simulate a gateway crash. Prints "ready" once listening and
// "registered <actorName>" per registered actor.
import { SidecarGateway } from "@pgfsm/async-worker-gateway";

const gateway = new SidecarGateway({
  socketPath: Deno.args[0],
  onActorRegistered: (actor) =>
    console.log(`registered ${actor.asyncOperationName}`),
});
await gateway.start();
console.log("ready");
