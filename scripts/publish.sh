#!/usr/bin/env bash
#
# Publish dsh-compaction-cacheaware to GitHub and register it for the
# DeepSeek Harness creative workshop.
#
# Prerequisites:
#   - gh CLI installed and authenticated.
#     On Windows/WSL the script will prefer `gh.exe` when the WSL `gh` is not
#     authenticated.
#   - This script is run from the repository root:
#       cd compaction-reasonix
#       ./scripts/publish.sh [repo-name]
#
# What it does:
#   1. Creates a public GitHub repo from the current directory and pushes.
#   2. Adds discoverability topics: dsh-plugin, deepseek-harness, reasonix.
#
# The DSH creative workshop (https://github.com/JxaMe/dsh-workshop) scans
# public GitHub repos with the `dsh-plugin` topic, so adding the topic is the
# workshop submission step.
set -euo pipefail

REPO_NAME="${1:-dsh-compaction-cacheaware}"

# Prefer the authenticated gh. On WSL, `gh.exe` often holds the Windows login.
GH_BIN="${GH_BIN:-gh}"
if ! "${GH_BIN}" auth status &>/dev/null && command -v gh.exe &>/dev/null; then
  GH_BIN="gh.exe"
fi

if ! "${GH_BIN}" auth status &>/dev/null; then
  echo "❌ gh is not authenticated. Run: gh auth login  (or gh.exe auth login on Windows)"
  exit 1
fi

OWNER="$("${GH_BIN}" api user -q .login)"
REPO="${OWNER}/${REPO_NAME}"

if "${GH_BIN}" repo view "${REPO}" &>/dev/null; then
  echo "ℹ️  Repo already exists: ${REPO}"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/${REPO}.git"
else
  echo "🚀 Creating public repo ${REPO} ..."
  "${GH_BIN}" repo create "${REPO_NAME}" --public --source . --remote origin --push
fi

echo "🏷️  Adding workshop/discoverability topics ..."
"${GH_BIN}" repo edit "${REPO}" --add-topic dsh-plugin
"${GH_BIN}" repo edit "${REPO}" --add-topic deepseek-harness
"${GH_BIN}" repo edit "${REPO}" --add-topic reasonix

echo "✅ Published: https://github.com/${REPO}"
echo "✅ Workshop discoverability enabled via topic 'dsh-plugin'."
echo "   See: https://JxaMe.github.io/dsh-workshop/"
