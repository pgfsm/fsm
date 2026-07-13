#!/bin/sh
# SessionStart hook: record the Claude session id and surface repo + issue
# context. Kept lightweight — issue triage only happens if the session turns
# out to be code work (see "Session Workflow" in CLAUDE.md).
# POSIX sh — no bashisms; jq is optional.

INPUT=$(cat)
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
else
  SESSION_ID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi

DIR=${CLAUDE_PROJECT_DIR:-.}
mkdir -p "$DIR/.claude"
if [ -n "$SESSION_ID" ]; then
  printf '%s\n' "$SESSION_ID" > "$DIR/.claude/.current-session-id"
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  REPO_URL=$(gh repo view --json url --jq '.url' 2>/dev/null)
  echo "Repo: ${REPO_URL:-unknown}"
  echo "Session ID: ${SESSION_ID:-unknown}"
  echo ""
  echo "## Open issues assigned to you (for reference if session is code work)"
  gh issue list --state open --assignee @me --limit 5 \
    --json number,title,labels \
    --template '{{range .}}#{{.number}}: {{.title}} [{{range .labels}}{{.name}} {{end}}]{{"\n"}}{{end}}'
  echo ""
  echo "## Top 5 unassigned open issues"
  gh issue list --state open --limit 5 --search "no:assignee" \
    --json number,title,labels \
    --template '{{range .}}#{{.number}}: {{.title}} [{{range .labels}}{{.name}} {{end}}]{{"\n"}}{{end}}'
else
  echo "gh CLI not authenticated - run 'gh auth login' to enable issue automation."
fi

exit 0
