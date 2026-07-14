// pre-commit hook (via prek): refuse commits on branches that don't follow
// the naming convention in AGENTS.md — <type>/<issue-number>-short-slug.
// Cross-platform: pure Deno, only shells out to `git`.

const ALLOWED =
  /^(main|renovate\/.+|(feat|bug|chore|design)\/\d+-[a-z0-9][a-z0-9-]*)$/;

const out = await new Deno.Command("git", {
  args: ["rev-parse", "--abbrev-ref", "HEAD"],
}).output();

if (!out.success) {
  // Not a repo / unborn ref — nothing to enforce here.
  Deno.exit(0);
}

const branch = new TextDecoder().decode(out.stdout).trim();

// Detached HEAD (rebase, cherry-pick, bisect) reports "HEAD" — allow.
if (branch === "HEAD" || ALLOWED.test(branch)) {
  Deno.exit(0);
}

console.error(
  `branch "${branch}" does not match the naming convention from AGENTS.md:\n` +
    `  <type>/<issue-number>-short-slug   (type: feat | bug | chore | design)\n` +
    `  e.g. bug/142-worker-lock-timeout\n` +
    `Rename with: git branch -m <type>/<issue>-<slug>`,
);
Deno.exit(1);
