#!/usr/bin/env bash
#
# Publish dsh-compaction-cacheaware to GitHub and register it for the
# DeepSeek Harness creative workshop.
#
# Prerequisites:
#   - gh CLI installed and authenticated: gh auth login
#   - This script is run from the repository root:
#       cd dsh-compaction-cacheaware
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

if ! gh auth status &>/dev/null; then
  echo "❌ gh is not authenticated. Run: gh auth login"
  exit 1
fi

OWNER="$(gh api user -q .login)"
REPO="${OWNER}/${REPO_NAME}"

if gh repo view "${REPO}" &>/dev/null; then
  echo "ℹ️  Repo already exists: ${REPO}"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/${REPO}.git"
else
  echo "🚀 Creating public repo ${REPO} ..."
  gh repo create "${REPO_NAME}" --public --source . --remote origin --push
fi

echo "🏷️  Adding workshop/discoverability topics ..."
gh repo edit "${REPO}" --add-topic dsh-plugin
gh repo edit "${REPO}" --add-topic deepseek-harness
gh repo edit "${REPO}" --add-topic reasonix

echo "✅ Published: https://github.com/${REPO}"
echo "✅ Workshop discoverability enabled via topic 'dsh-plugin'."
echo "   See: https://JxaMe.github.io/dsh-workshop/"
