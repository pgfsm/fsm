// The reference manifests pull the gateway image published for this package's
// version (gateway-release.yml, #486), so a release bump must move them too.
import { assertEquals } from "@std/assert";

const root = new URL("../", import.meta.url);
const IMAGE = "ghcr.io/pgfsm/async-worker-gateway";

const { version } = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", root)),
) as { version: string };

for (
  const manifest of [
    "deploy/k8s/base/gateway.yaml",
    "deploy/k8s/single-pod/deployment.yaml",
  ]
) {
  Deno.test(`${manifest} pulls the gateway image for version ${version}`, async () => {
    const text = await Deno.readTextFile(new URL(manifest, root));
    const tags = [...text.matchAll(new RegExp(`image: ${IMAGE}:(\\S+)`, "g"))]
      .map((match) => match[1]);
    assertEquals(tags, [version]);
  });
}
