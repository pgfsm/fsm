import { spawnSync } from "node:child_process";
import { join } from "@std/path";

/**
 * Module dirs whose go.mod the compiler regenerates: the Go actors aggregate
 * first, since the worker module requires it.
 */
const GO_MODULE_DIRS = [
  "async-worker/go/go-actors-registry-generated",
  "async-worker/go",
];

export type GoTidyResult = "tidied" | "no-go" | "failed";

/**
 * Runs `go mod tidy` in the project's generated Go modules so the Go worker
 * builds straight away. @pgfsm/compiler does this itself only under Deno --
 * its npm/npx build can't spawn processes (no Deno.Command in dnt's shim) --
 * so without this an npx-created project has no go.sum. node:child_process
 * works under both runtimes. Best-effort: never fails the command.
 */
export function goModTidy(root: string): GoTidyResult {
  // Tests set this: tidy fetches the Go SDK over the network.
  if (Deno.env.get("PGFSM_SKIP_GO_TIDY")) return "tidied";
  const probe = spawnSync("go", ["version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) return "no-go";
  for (const dir of GO_MODULE_DIRS) {
    const res = spawnSync("go", ["mod", "tidy"], {
      cwd: join(root, dir),
      stdio: "ignore",
    });
    if (res.error || res.status !== 0) return "failed";
  }
  return "tidied";
}
