import { build, emptyDir } from "@deno/dnt";

await emptyDir("./dist");

const packageVersion = Deno.args[0]?.replace(/^v/, "") ?? "0.0.0";

// @pgfsm/proto-codegen is published to npm independently (proto-publish.yml,
// from a proto-v* tag) — map its subpath imports to the real npm dependency
// instead of letting dnt inline the generated stubs, so a new proto release
// reaches this package via semver. Version is read from its own deno.json
// rather than hardcoded, same as fsm-sync-worker-ts's build-npm.ts does for
// @pgfsm/db/@pgfsm/logging.
const protoCodegenDenoJson = JSON.parse(
  await Deno.readTextFile("../fsm-proto-codegen/gen/typescript/deno.json"),
);
const protoCodegenVersionRange = `^${protoCodegenDenoJson.version}`;

await build({
  entryPoints: ["./src/index.ts"],
  outDir: "./dist",
  shims: {
    deno: true,
  },
  mappings: {
    "@pgfsm/proto-codegen/sidecargateway/v1/connect": {
      name: "@pgfsm/proto-codegen",
      version: protoCodegenVersionRange,
      subPath: "sidecargateway/v1/connect",
    },
    "@pgfsm/proto-codegen/sidecargateway/v1/pb": {
      name: "@pgfsm/proto-codegen",
      version: protoCodegenVersionRange,
      subPath: "sidecargateway/v1/pb",
    },
  },
  // The tests start a real SidecarGateway from @pgfsm/async-worker-gateway, a
  // workspace-only dev dependency (it pulls in pg) — keep them out of the
  // published build and dnt's Node test run.
  test: false,
  package: {
    name: "@pgfsm/async-worker-sdk",
    version: packageVersion,
    description:
      "TypeScript worker SDK for the pgfsm Activity Gateway: registers compiler-generated actors over the sidecar gRPC stream and serves invocations",
    license: "Apache-2.0",
  },
  compilerOptions: {
    lib: ["ES2022", "DOM"],
    target: "ES2022",
  },
  postBuild() {
    if (Deno.args.includes("--copy-readme")) {
      Deno.copyFileSync("README.md", "dist/README.md");
    }
  },
});
