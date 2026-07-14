# AGENTS.md

Protocol for coding agents working in this repository — Claude Code, Cursor,
Codex, Gemini CLI, or any other. Humans pairing with an agent follow the same
flow. Build commands, architecture, and naming conventions live in `CLAUDE.md`
(readable by any agent — the name is historical).

Instructions here are the soft layer. The hard invariants (branch names, issue
references, PR linkage) are enforced by prek git hooks and CI regardless of
which agent — or human — does the work. See [Enforcement](#enforcement).

## Session gate

At the start of every session, before doing anything else, ask:

> "What are we doing in this session today? a) Explore / understand the
> codebase, experiment, or general Q&A b) Design / architecture work (new
> component, cross-cutting change, execution-model decision) c) Working on the
> codebase — feature, bug, or chore"

### (a) Explore / experiment / Q&A

Continue normally. Don't touch GitHub issues. Code changes are fine here —
experiments and throwaway work don't need an issue. If exploration turns into
real design or implementation work, stop and re-enter the gate as (b) or (c).

### (b) Design / architecture → spec-driven path

**Do not write implementation code in a design session.** The deliverable is a
reviewed spec, not code.

1. Interrogate the design before writing anything. Cover, in order:
   - **Problem** — what breaks or is impossible today? Who is affected?
   - **Constraints** — what is fixed? Check the standing architectural
     constraints in `docs/kb/` (e.g. KB-001: bounded worker fleet, connection
     minimization, polyglot via queue) and `docs/adr/` — a spec that violates an
     accepted ADR must say so explicitly and propose superseding it.
   - **Options** — at least two, with trade-offs. Propose options the user
     didn't mention.
   - **Decision drivers** — why the chosen option wins.
   - **Consequences & migration** — what gets harder, rollback story.
   - **Acceptance criteria** — how we'll know it's implemented correctly.
2. Write the spec: copy `docs/specs/TEMPLATE.md` to
   `docs/specs/spec-NNN-short-slug.md` (next free number), status **Draft**.
3. Create a design issue and link the session (see
   [Issue linking](#issue-linking)):

   ```bash
   gh issue create --title "design: <title>" --body "<one-paragraph summary + link to spec path>" --label design --assignee @me
   ```

4. Open a **spec-only PR** on branch `design/<issue-number>-short-slug`. The PR
   body must contain `Spec: docs/specs/spec-NNN-short-slug.md` and
   `Closes #<issue-number>`. No implementation code rides along.
5. Humans review the design in the PR. On merge, the spec's status becomes
   **Accepted**; cut implementation issues that link back to the spec. Durable,
   hard-to-reverse decisions graduate to `docs/adr/` (see `docs/specs/README.md`
   for the lifecycle).

Claude Code users: the `/design-spec` skill walks through this path.

### (c) Feature / bug / chore → issue-driven path

1. List open issues (assigned to the current user, plus unassigned):

   ```bash
   gh issue list --state open --assignee @me
   gh issue list --state open --search "no:assignee"
   ```

2. Ask which issue number this session is for; if it isn't listed, help create
   one (see below).

#### If they give an issue number

- Confirm it exists and read details: `gh issue view <n>`
- Assign it: `gh issue edit <n> --add-assignee @me`
- Link the session (see [Issue linking](#issue-linking))
- Confirm the type from its labels; if missing, ask and add one (**feature =
  `enhancement`**): `gh issue edit <n> --add-label <bug|enhancement|chore>`

#### If the issue doesn't exist yet

Ask for:

- Type: bug, feature (label: `enhancement`), or chore
- A short title and one-paragraph description
- For bugs: repro steps and expected vs. actual behavior
- For features: the user-facing outcome and any acceptance criteria
- For chores: why it's needed and what "done" looks like

Then create, assign, and link:

```bash
gh issue create --title "<title>" --body "<body>" --label <type> --assignee @me
```

Issues created via `gh` bypass the issue forms, so also add the matching
`area: *` label — the component→label mapping lives in
`.github/advanced-issue-labeler.yml`.

## Issue linking

Every code-work session posts a comment on its issue so anyone can see which
agent is (or was) on it:

```bash
gh issue comment <n> --body "🤖 <agent-name> session linked: <session-id>"
```

Claude Code records its session id in `.claude/.current-session-id` (written by
the SessionStart hook) — use
`gh issue comment <n> --body "🤖 Claude session linked: $(cat .claude/.current-session-id)"`.
Agents without a session id post their name and start time instead.

## Multi-agent coordination

- **Assignment is the lock.** Never start work on an issue assigned to someone
  else. If an issue looks stale, comment and ask — don't take it.
- **One issue, one branch.** Branch `<type>/<issue-number>-short-slug` where
  type is `feat | bug | chore | design` (e.g. `bug/142-worker-lock-timeout`).
- **Commits reference the issue**: `fix(worker): handle lock timeout (#142)`.
- **Agent attribution**: end commit messages with a
  `Co-Authored-By: <agent> <noreply@...>` trailer so `git log` shows which agent
  wrote what.
- **PRs include `Closes #<number>`** so merging auto-closes the issue. Design
  PRs also include the `Spec:` line.
- **Parallel sessions use worktrees.** Default to working directly on a branch
  in the current directory. If another agent session is already active on this
  repo, or the user asks for isolation, create a worktree:
  `git worktree add .claude/worktrees/<type>-<issue-number> -b <type>/<issue-number>-slug`
  and tell the user the path. Caveat: the API dev server (port 9999) and local
  Supabase are shared services — only one worktree can run them at a time;
  coordinate before starting either, or change `PORT` in that worktree's `.env`.

## Enforcement

These invariants are checked mechanically; agents should satisfy them rather
than discover them at commit time:

- **prek `commit-msg` hook** — commits on `feat/* | bug/* | chore/* | design/*`
  branches must reference an issue (`(#<n>)` or `#<n>` anywhere in the message).
  Run `prek install` once per clone (installs all configured hook stages).
- **prek `pre-commit` hook** — branch name must be `main`, `renovate/*`, or
  match `<type>/<issue-number>-short-slug`.
- **CI `pr-lint`** — PR body must contain `Closes #<n>` (design PRs: also a
  `Spec: docs/specs/...` line); head branch must match the naming convention.
- Merges to `main` go through PRs with human review — no agent merges its own
  work unreviewed.
