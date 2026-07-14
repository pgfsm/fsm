// commit-msg hook (via prek): on work branches (feat/bug/chore/design), the
// commit message must reference a GitHub issue, e.g. "fix(worker): handle
// lock timeout (#142)" — see AGENTS.md conventions.
// Cross-platform: pure Deno, only shells out to `git`.
// Receives the commit-message file path as its only argument.

const WORK_BRANCH = /^(feat|bug|chore|design)\//;
// Commits that legitimately carry no issue ref of their own.
const EXEMPT_SUBJECT = /^(Merge |fixup!|squash!|amend!)/;

const msgFile = Deno.args[0];
if (!msgFile) Deno.exit(0);

const out = await new Deno.Command("git", {
  args: ["rev-parse", "--abbrev-ref", "HEAD"],
}).output();
const branch = out.success ? new TextDecoder().decode(out.stdout).trim() : "";

if (!WORK_BRANCH.test(branch)) Deno.exit(0);

const raw = await Deno.readTextFile(msgFile);
// Drop git's comment lines before matching — "#" is the comment char, and a
// scissors block or status listing must not satisfy the issue-ref check.
const msg = raw
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n");

const subject = msg.trimStart().split("\n", 1)[0] ?? "";
if (EXEMPT_SUBJECT.test(subject)) Deno.exit(0);

if (/#\d+/.test(msg)) Deno.exit(0);

const issueFromBranch = branch.match(/^[a-z]+\/(\d+)-/)?.[1];
console.error(
  `commit message has no issue reference (#<n>), required on "${branch}".\n` +
    `Convention (AGENTS.md): <type>(<scope>): <summary> (#<issue>)\n` +
    (issueFromBranch
      ? `This branch belongs to issue #${issueFromBranch} — append (#${issueFromBranch}).`
      : `Append the issue number, e.g. (#142).`),
);
Deno.exit(1);
