#!/usr/bin/env bash
#
# One-click publish dsh-compaction-cacheaware to npm registry.
# Usage:
#   ./scripts/publish-npm.sh        # patch 0.1.2 -> 0.1.3
#   ./scripts/publish-npm.sh patch  # explicit bump type
#   ./scripts/publish-npm.sh minor  # 0.1.2 -> 0.2.0
#   ./scripts/publish-npm.sh major  # 0.1.2 -> 1.0.0
#
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "❌ bump must be patch|minor|major, got: $BUMP"
  exit 1
fi

echo "🔍 Checking npm login..."
if ! npm whoami &>/dev/null; then
  echo "❌ 未登录 npm，请先运行: npm login"
  echo "   登录后用 npm whoami 确认"
  exit 1
fi
echo "✅ npm user: $(npm whoami)"

echo "🔍 Quality gates..."
npm run typecheck
npm run build
npm test
echo "✅ typecheck / build / test passed"

OLD=$(node -p "require('./package.json').version")
echo "📦 Bumping version: $OLD -> $BUMP"
npm version "$BUMP" --no-git-tag-version
NEW=$(node -p "require('./package.json').version")
echo "📦 $OLD -> $NEW"

echo "🚀 Publishing dsh-compaction-cacheaware@$NEW to npm..."
# prepack (typecheck && build) runs automatically; build already done above
npm publish --access public
echo "✅ Published: https://www.npmjs.com/package/dsh-compaction-cacheaware/v/$NEW"

echo "🏷️  Committing and tagging..."
# package-lock may not exist (pnpm project), so tolerate missing
git add package.json 2>/dev/null || true
if [[ -f package-lock.json ]]; then git add package-lock.json 2>/dev/null || true; fi
if [[ -f pnpm-lock.yaml ]]; then git add pnpm-lock.yaml 2>/dev/null || true; fi
# keep compiled lib in sync with tag
git add lib/ 2>/dev/null || true
git commit -m "release: $NEW"
git tag "v$NEW"
git push origin main
git push origin "v$NEW"

echo ""
echo "✅ Done: dsh-compaction-cacheaware@$NEW"
echo "   npm:  https://www.npmjs.com/package/dsh-compaction-cacheaware"
echo "   tag:  v$NEW pushed to origin"
