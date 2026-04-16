#!/usr/bin/env bash
# Project-local Supabase CLI wrapper.
#
# Problem this solves: `supabase login` stores auth globally in ~/.supabase/,
# which breaks when working on multiple projects with different Supabase accounts.
#
# This wrapper reads SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF from the
# project's .env.local (git-ignored), so each project has its own credentials
# without touching global CLI state.
#
# Usage:
#   ./scripts/sb.sh functions deploy aim2026-calc-kpis-v2
#   ./scripts/sb.sh functions list
#   ./scripts/sb.sh secrets list
#   ./scripts/sb.sh db push
#
# Setup:
#   1. Get a Personal Access Token: https://supabase.com/dashboard/account/tokens
#   2. Copy .env.local.example to .env.local
#   3. Fill in SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF
#   4. Run this script

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_LOCAL="$PROJECT_ROOT/.env.local"

if [ ! -f "$ENV_LOCAL" ]; then
  echo "ERROR: .env.local not found at $ENV_LOCAL" >&2
  echo "" >&2
  echo "Setup:" >&2
  echo "  1. Copy .env.local.example to .env.local:" >&2
  echo "     cp .env.local.example .env.local" >&2
  echo "" >&2
  echo "  2. Get a Personal Access Token from:" >&2
  echo "     https://supabase.com/dashboard/account/tokens" >&2
  echo "" >&2
  echo "  3. Fill in .env.local with:" >&2
  echo "     SUPABASE_ACCESS_TOKEN=sbp_..." >&2
  echo "     SUPABASE_PROJECT_REF=teewkafclgpfpczftvah" >&2
  exit 1
fi

# Load only SUPABASE_* vars from .env.local (safe; doesn't execute code).
while IFS='=' read -r key value; do
  # Skip comments and blank lines
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$key" ]] && continue
  key="${key// /}"
  # Strip surrounding quotes if any
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  case "$key" in
    SUPABASE_ACCESS_TOKEN|SUPABASE_PROJECT_REF)
      export "$key=$value"
      ;;
  esac
done < "$ENV_LOCAL"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN missing from .env.local" >&2
  exit 1
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "ERROR: SUPABASE_PROJECT_REF missing from .env.local" >&2
  exit 1
fi

# Append --project-ref automatically for commands that need it, unless the
# user already provided one.
needs_project_ref=false
case "$1 $2" in
  "functions deploy"|"functions list"|"functions logs"|"functions delete"|"functions download")
    needs_project_ref=true
    ;;
  "secrets list"|"secrets set"|"secrets unset")
    needs_project_ref=true
    ;;
  "db push"|"db pull"|"db diff")
    needs_project_ref=true
    ;;
esac

already_has_ref=false
for arg in "$@"; do
  if [[ "$arg" == "--project-ref" || "$arg" == --project-ref=* ]]; then
    already_has_ref=true
    break
  fi
done

if $needs_project_ref && ! $already_has_ref; then
  exec supabase "$@" --project-ref "$SUPABASE_PROJECT_REF"
else
  exec supabase "$@"
fi
