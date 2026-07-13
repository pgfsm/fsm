---
name: add-issue-form
description: Create or modify GitHub Issue Forms in .github/ISSUE_TEMPLATE/ and keep the input-driven labeling pipeline in sync — the advanced-issue-labeler policy and the issue-labeler workflow. Use when adding a new issue template, adding/renaming dropdown options in an existing one, or changing which labels form answers map to.
argument-hint: <new-form-name | change to make>
---

# Add / Update GitHub Issue Forms

This repo uses GitHub Issue Forms with **input-driven labeling**. Three files
must always stay in sync — changing one without the others silently breaks
labeling (the labeler action matches dropdown answers by exact string):

1. `.github/ISSUE_TEMPLATE/<form>.yml` — the form (dropdown option strings)
2. `.github/advanced-issue-labeler.yml` — policy mapping option strings → labels
   (`keys` must match option strings **verbatim**)
3. `.github/workflows/issue-labeler.yml` — one job per form, keyed on the form's
   static type label

## Repo conventions

- Every form applies two static labels: its type label (`bug`, `enhancement`,
  `chore`, ...) plus `triage`.
- The type label is what the workflow job's `if:` condition branches on — it
  must be unique per form.
- The **Component dropdown is shared verbatim across all forms** (same
  `id: component`, identical option strings). Copy it from `bug_report.yml`;
  never fork the wording.
- Label namespaces: `area: <x>` (component), `exec: <x>` (execution model),
  `severity: <x>`, `chore: <x>`. New dropdowns that drive labels get their own
  short namespace.
- Dropdown options that should NOT produce a label ("Not applicable", "Other",
  "Unsure") go in that section's `block-list`.
- Forms use `render: json` for FSM definitions, `render: shell` for logs.
- `config.yml` disables blank issues — every issue type needs a form, or it has
  nowhere to go. Dependency bumps are Renovate's job; don't create a form for
  them.

## Task: create a new form

1. Read `bug_report.yml` and `chore.yml` first — new forms follow their
   structure (chore is the minimal example, bug the maximal one).
2. Ask/infer: form purpose, static type label, which fields are needed, and
   which dropdowns should drive labels.
3. Write `.github/ISSUE_TEMPLATE/<name>.yml`:
   - snake_case filename; `name:` with a leading emoji; `title: "[Xxx]: "`
     prefix.
   - `labels: ["<type>", "triage"]`.
   - Include the shared component dropdown copied verbatim.
   - Mark fields `required: true` only when triage genuinely needs them.
4. Update `.github/advanced-issue-labeler.yml` (**the meta task — never skip**):
   - Add the new filename to the policy's `template:` list.
   - For each new label-driving dropdown, add a `section` entry:
     `id: [<dropdown-id>]`, `keys` copied verbatim from the form's option
     strings, non-labeling options in `block-list`.
5. Add a job to `.github/workflows/issue-labeler.yml`: copy an existing
   `label-*` job, change the job name, the `if: contains(...)` type label,
   `template-path`, and `template`.
6. Validate every touched file:
   ```
   deno eval "import { parse } from 'jsr:@std/yaml'; parse(await Deno.readTextFile('<file>')); console.log('OK')"
   ```
7. Tell the user which new labels to pre-create
   (`gh label create "<label>" --color <hex>`) — missing labels are auto-created
   with random colors on first use, so this is optional but recommended.

## Task: modify an existing form

For any change to a dropdown that drives labels (add / rename / remove an
option):

1. Grep the old option string across `.github/ISSUE_TEMPLATE/*.yml` AND
   `.github/advanced-issue-labeler.yml` — update every occurrence. A renamed
   option with a stale policy `key` fails silently (no label applied, no error).
2. If the dropdown is the shared component dropdown, apply the change to **all**
   forms, not just the one the user mentioned, and update the matching `area:`
   entry in the policy.
3. If an option is removed, remove its policy entry too; if a label becomes
   orphaned, mention it so the user can decide whether to delete it from GitHub.
4. Validate YAML as above.

## Task: change label mappings only

Edits confined to `.github/advanced-issue-labeler.yml` (e.g. renaming a label):
confirm the `keys` still match the current form option strings by grepping them,
then validate. Remind the user that renamed labels must exist on GitHub (or will
be auto-created) and old ones stay behind on existing issues.
