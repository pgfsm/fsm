---
name: design-spec
description: Run the spec-driven design path from AGENTS.md — interrogate a design/architecture idea (problem, constraints, options, drivers, consequences, acceptance criteria), write a spec in docs/specs/, create the design issue, and open a spec-only PR. Use when a session is classified as design/architecture work, or the user wants to design a new component, cross-cutting change, or execution-model decision before implementing it.
argument-hint: <one-line description of the design topic>
---

# Design Spec (spec-driven development)

The deliverable of this skill is a **reviewed spec, not code**. Do not write
implementation code anywhere in this flow — if the user drifts toward "just
build it", remind them the point is to get the design reviewed first, and finish
the spec.

## Step 1 — Interrogate the design

Work through these six areas **in order, conversationally** — ask, don't assume.
Push back on vague answers; a spec built on "it should be scalable" is
worthless. Batch related questions (AskUserQuestion works well), but do not skip
an area:

1. **Problem** — What breaks or is impossible today? Who hits it? Why now? If
   the user can't name a concrete failure, challenge whether this needs
   designing at all.
2. **Constraints** — Before asking, read `docs/kb/` and `docs/adr/` (including
   the per-package ADRs indexed in `docs/adr/README.md`). Present the standing
   constraints that apply (e.g. KB-001: bounded worker fleet, connection
   minimization, polyglot via queue) and ask what else is fixed: compatibility,
   performance envelopes, runtimes, team capacity. If the idea conflicts with an
   accepted ADR, surface that now — the spec must explicitly propose superseding
   it.
3. **Options** — Get to at least two real options. Propose alternatives the user
   didn't mention, including the "do nothing / smaller hammer" option. For each:
   what it is, pros, cons under the constraints.
4. **Decision drivers** — Which constraint or property actually decides it? Make
   the user pick; record why the losing options lose.
5. **Consequences & migration** — What gets harder? Migration from today's
   state, and the rollback story if the decision is wrong.
6. **Acceptance criteria** — Checkable statements defining "implemented
   correctly". These become the implementation issues' acceptance criteria.

## Step 2 — Write the spec

- Copy `docs/specs/TEMPLATE.md` to `docs/specs/spec-NNN-short-slug.md` using the
  next free number (check existing files and the index in
  `docs/specs/README.md`).
- Status **Draft**, today's date, authors = the human + this agent.
- Fill every section from the interrogation. Keep options honest — don't
  retro-fit the writeup to make the chosen option look inevitable.
- Add the spec to the index table in `docs/specs/README.md`.

## Step 3 — Issue, branch, PR

1. Create and link the design issue (label `design` is applied statically by the
   issue form, but specs created here go via `gh`, so pass it explicitly; also
   add the matching `area: *` label per `.github/advanced-issue-labeler.yml`):

   ```bash
   gh issue create --title "design: <title>" --body "<problem paragraph + Spec: docs/specs/spec-NNN-....md>" --label design --assignee @me
   gh issue comment <n> --body "🤖 Claude session linked: $(cat .claude/.current-session-id)"
   ```

2. Branch `design/<issue-number>-short-slug`, commit the spec (message
   references the issue, e.g. `docs(spec): <title> (#<n>)`).
3. Open the spec-only PR. Body must contain both lines:

   ```
   Spec: docs/specs/spec-NNN-short-slug.md
   Closes #<issue-number>
   ```

4. Tell the user: the spec is now in human review. After the PR merges, flip the
   status to **Accepted**, cut implementation issues linking back to the spec,
   and normal issue-driven sessions take it from there (see AGENTS.md).
