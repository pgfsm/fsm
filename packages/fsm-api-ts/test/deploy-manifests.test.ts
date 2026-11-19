// The reference manifests pull the API image published for this package's
// version (api-release.yml, SPEC-016), so a release bump must move them too.
import { assertEquals } from "@std/assert";

const root = new URL("../", import.meta.url);
const IMAGE = "ghcr.io/pgfsm/api";

const { version } = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", root)),
) as { version: string };

for (
  const manifest of [
    "deploy/k8s/base/api.yaml",
    "deploy/k8s/base/api-admin.yaml",
  ]
) {
  Deno.test(`${manifest} pulls the API image for version ${version}`, async () => {
    const text = await Deno.readTextFile(new URL(manifest, root));
    const tags = [...text.matchAll(new RegExp(`image: ${IMAGE}:(\\S+)`, "g"))]
      .map((match) => match[1]);
    assertEquals(tags, [version]);
  });
}
