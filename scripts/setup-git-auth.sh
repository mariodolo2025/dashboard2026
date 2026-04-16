#!/usr/bin/env bash
# Configure this repo's git to use a project-local GitHub token (from .env.local)
# instead of the globally-logged-in `gh` CLI account.
#
# Why: `gh auth login` and Windows Credential Manager both store GitHub auth
# globally. When multiple projects target different GitHub accounts, one of
# them will always fail to push to a private repo.
#
# What this does: writes a credential helper into `.git/config` (local to
# this clone) that reads GITHUB_TOKEN from .env.local. Nothing global is
# touched; nothing is pushed with the repo.
#
# Run once after filling in GITHUB_TOKEN in .env.local.

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_LOCAL="$PROJECT_ROOT/.env.local"

if [ ! -f "$ENV_LOCAL" ]; then
  echo "ERROR: .env.local not found at $ENV_LOCAL" >&2
  echo "Copy .env.local.example to .env.local and fill in GITHUB_TOKEN." >&2
  exit 1
fi

# Load GITHUB_TOKEN + GITHUB_USERNAME from .env.local
GITHUB_TOKEN=""
GITHUB_USERNAME=""
while IFS='=' read -r key value; do
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$key" ]] && continue
  key="${key// /}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  case "$key" in
    GITHUB_TOKEN) GITHUB_TOKEN="$value" ;;
    GITHUB_USERNAME) GITHUB_USERNAME="$value" ;;
  esac
done < "$ENV_LOCAL"

if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN is empty in .env.local" >&2
  exit 1
fi

if [ -z "$GITHUB_USERNAME" ]; then
  GITHUB_USERNAME="x-access-token"
fi

cd "$PROJECT_ROOT"

HELPER_SCRIPT="$PROJECT_ROOT/scripts/git-credential-env-local.sh"
chmod +x "$HELPER_SCRIPT" 2>/dev/null || true

# Clear any inherited credential helpers for this repo, then point to our own
# script that reads the token from .env.local at push/pull time. No secrets
# are written to .git/config.
git config --local --unset-all credential.helper 2>/dev/null || true
# The empty "" helper wipes any global/system helpers for this repo only;
# the second line appends our helper script.
#
# We wrap the script invocation in a shell function (via `!f() {...}; f`) so
# that paths containing spaces (e.g. "AIM 2026") are passed correctly. Without
# the `!` prefix, git would try to invoke `credential-<path>` as a subcommand,
# and a raw path with spaces gets mis-tokenized.
git config --local credential.helper ''
git config --local --add credential.helper "!f() { bash \"$HELPER_SCRIPT\" \"\$@\"; }; f"

echo "Git credential helper configured for this repo."
echo "  Username: ${GITHUB_USERNAME:-x-access-token}"
echo "  Token:    ${GITHUB_TOKEN:0:8}... (from .env.local)"
echo ""
echo "Try: git push origin main"
