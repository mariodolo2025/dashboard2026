#!/usr/bin/env bash
# Git credential helper that reads GITHUB_TOKEN / GITHUB_USERNAME
# from the project's .env.local file.
#
# Wired up by scripts/setup-git-auth.sh via `git config credential.helper`.
# Never reads or writes anywhere outside this project.

# Only respond to the "get" operation. Git also calls "store" and "erase";
# we ignore those (we don't persist anything — the source of truth is .env.local).
[ "$1" = "get" ] || exit 0

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_LOCAL="$PROJECT_ROOT/.env.local"

if [ ! -f "$ENV_LOCAL" ]; then
  exit 0
fi

TOKEN=""
USER=""
while IFS='=' read -r key value; do
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$key" ]] && continue
  key="${key// /}"
  # Strip surrounding quotes
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  case "$key" in
    GITHUB_TOKEN) TOKEN="$value" ;;
    GITHUB_USERNAME) USER="$value" ;;
  esac
done < "$ENV_LOCAL"

if [ -z "$TOKEN" ]; then
  exit 0
fi

[ -z "$USER" ] && USER="x-access-token"

echo "username=$USER"
echo "password=$TOKEN"
