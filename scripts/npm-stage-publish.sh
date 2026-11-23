#!/usr/bin/env bash
# Stages the npm package in the current directory (a dnt `dist/` or an
# unpacked `deno pack` tarball) with `npm stage publish` (#719). Used by every
# npm publish job: npm-publish.yml, proto-publish.yml, gateway-release.yml,
# api-release.yml. CI-only: GitHub's ubuntu runners have bash and jq.
#
# Auth is npm trusted publishing: the job needs `permissions: id-token: write`
# and the package needs a trusted publisher on npmjs.com naming this repo and
# the calling workflow file. There is no NPM_TOKEN: npm's granular tokens
# can't publish without 2FA (EOTP) and lose direct publish in January 2027.
#
# Staging doesn't make the version installable. A maintainer approves it with
# 2FA (`npm stage list <name>` then `npm stage approve <stage-id>`, or on the
# package's page on npmjs.com), so a leaked CI identity can't release anything.
#
# Usage: npm-stage-publish.sh <dist-tag>
set -euo pipefail

dist_tag=${1:?usage: npm-stage-publish.sh <dist-tag>}
name=$(jq -r .name package.json)
version=$(jq -r .version package.json)

# `npm stage publish` needs npm >= 11.15.0, and setting a dist-tag through
# OIDC (every stage passes --tag) needs >= 11.21.0. npm is pinned in the root
# .prototools, so an older one means that pin went backwards or the job
# didn't install it.
npm_version=$(npm --version)
IFS=. read -r npm_major npm_minor _ <<<"$npm_version"
if ((npm_major < 11 || (npm_major == 11 && npm_minor < 21))); then
  echo "::error::npm $npm_version is too old to stage with a dist-tag through OIDC; needs >= 11.21.0 (the npm pin in .prototools)"
  exit 1
fi

# Trusted publishing rejects a package whose repository.url isn't the
# publishing repo, after the build. Fail here with the reason instead.
repo_url=$(jq -r '.repository | if type == "object" then .url else . end // empty' package.json)
if [[ "$repo_url" != *"github.com/$GITHUB_REPOSITORY"* ]]; then
  echo "::error::$name's package.json repository.url is '${repo_url}', not github.com/$GITHUB_REPOSITORY: npm trusted publishing would reject it"
  exit 1
fi

# The OIDC identity can stage but can't run `npm stage list`, so a version an
# earlier run already staged isn't detectable up front: npm refuses to stage
# a version twice, and that lands here.
if ! npm stage publish --access public --tag "$dist_tag" --provenance; then
  echo "::error::npm stage publish of $name@$version failed. If an earlier run already staged it, approve or reject that one instead (npm stage list $name). If npm says the request isn't authorized, check $name's trusted publisher on npmjs.com names this repo and workflow file ($GITHUB_WORKFLOW_REF)."
  exit 1
fi

msg="$name@$version is staged (dist-tag $dist_tag) and not installable yet: approve it with 2FA via \`npm stage list $name\` + \`npm stage approve <stage-id>\`, or on https://www.npmjs.com/package/$name"
echo "::notice::$msg"
echo "$msg" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
