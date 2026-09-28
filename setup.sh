#!/bin/sh
# fleet-hooks setup — arm the fail-closed credential key-scan pre-commit
# in the repository you run it from (run at any depth inside that repo).
#
# Requires .githooks/pre-commit to exist at the repo root first (vendor it:
# see README "Install"). Fail-closed: if the hook file is missing we do NOT
# arm a hooksPath that would silently disable scanning.
#
# Exit codes: 0 armed (smoke pass), 1 setup failure, propagates the hook's
# own exit code (1/2) if the smoke run finds staged credential-shaped strings
# — that is the hook working correctly on a dirty index.

set -eu

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "fleet-hooks setup: FAIL: not inside a git repository" >&2
  exit 1
}

root=$(git rev-parse --show-toplevel)

if [ ! -f "$root/.githooks/pre-commit" ]; then
  echo "fleet-hooks setup: FAIL: $root/.githooks/pre-commit not found." >&2
  echo "  Vendor it first, e.g.:" >&2
  echo "    git clone --depth 1 https://github.com/SuperInstance/fleet-hooks /tmp/fleet-hooks && cp -r /tmp/fleet-hooks/.githooks . && rm -rf /tmp/fleet-hooks" >&2
  echo "  Refusing to arm core.hooksPath at a path with no hook (fail-closed)." >&2
  exit 1
fi

chmod +x "$root/.githooks/pre-commit"
git config core.hooksPath .githooks

echo "fleet-hooks: armed."
echo "  repo:          $root"
echo "  core.hooksPath $(git config core.hooksPath)"
echo "  pre-commit:    fail-closed credential key-scan (ghp_/gho_/ghs_/ghu_, github_pat_, sk-ant prefix, AKIA)"
echo "  escape hatch:  FLEET_ALLOW=<ERE>  (per-invocation, loud — only for obviously-fake fixtures)"
echo "  verify:        git config core.hooksPath   # -> .githooks"

# smoke: run the hook against the current index right now
printf 'fleet-hooks: smoke — scanning current index ...\n'
sh "$root/.githooks/pre-commit"
printf 'fleet-hooks: smoke PASS (index clean or nothing staged).\n'
