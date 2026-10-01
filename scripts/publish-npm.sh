#!/usr/bin/env bash
# Publish an already committed and pushed release. This script never bumps the
# package version, creates Git refs, commits files, or pushes to a remote.
# Usage: ./scripts/publish-npm.sh 0.2.0
set -euo pipefail
cd "$(dirname "$0")/.."

PACKAGE_NAME="dsh-compaction-cacheaware"
# The host's configured npm cache may be read-only (including its log path).
# Keep release cache writes in the ignored repo temp directory by default; CI or
# maintainers can override this with NPM_RELEASE_CACHE.
NPM_RELEASE_CACHE="${NPM_RELEASE_CACHE:-$PWD/.tmp/npm-cache}"
mkdir -p "$NPM_RELEASE_CACHE"
npm_release() {
  command npm --cache "$NPM_RELEASE_CACHE" "$@"
}

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <target-version> (for example: 0.2.0)" >&2
  exit 2
fi
TARGET="$1"
if [[ ! "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ target-version must be a stable x.y.z version, got: $TARGET" >&2
  exit 2
fi

PACKAGE_VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"
if [[ "$PACKAGE_VERSION" != "$TARGET" ]]; then
  echo "❌ package.json is $PACKAGE_VERSION; set and commit the intended target $TARGET first" >&2
  exit 1
fi

BRANCH="$(git symbolic-ref --quiet --short HEAD)" || {
  echo "❌ release must run from a named branch, not detached HEAD" >&2
  exit 1
}
HEAD_COMMIT="$(git rev-parse HEAD)"
WORKTREE="$(git status --porcelain --untracked-files=all)"
if [[ -n "$WORKTREE" ]]; then
  echo "❌ release worktree is not clean; commit every release file first" >&2
  printf '%s\n' "$WORKTREE" >&2
  exit 1
fi

TAG="v$TARGET"
TAG_COMMIT="$(git rev-parse --verify "$TAG^{commit}" 2>/dev/null)" || {
  echo "❌ local tag $TAG is missing; create and push the release tag before npm publish" >&2
  exit 1
}
if [[ "$TAG_COMMIT" != "$HEAD_COMMIT" ]]; then
  echo "❌ $TAG points to $TAG_COMMIT, not current release commit $HEAD_COMMIT" >&2
  exit 1
fi

COMMITTED_FILES="$(git ls-tree -r --name-only "$TAG_COMMIT")"
require_file() {
  if ! grep -Fqx -- "$1" <<<"$COMMITTED_FILES"; then
    echo "❌ release tag is missing required file: $1" >&2
    exit 1
  fi
}
require_prefix_match() {
  if ! grep -Eq -- "$1" <<<"$COMMITTED_FILES"; then
    echo "❌ release tag is missing committed files matching: $1" >&2
    exit 1
  fi
}
for path in \
  package.json README.md LICENSE cordis.patch.yml cordis.patch.example.yml \
  src/index.ts src/engine.ts lib/index.js lib/engine.js lib/types/index.d.ts \
  tests/selection.test.mjs tests/engine.integration.test.mjs \
  docs/PROJECT.md docs/MAINTENANCE.md docs/MIGRATION_BRIEF.md \
  docs/MIGRATION_0.1.11_TO_0.2.0.md docs/UPSTREAM_SYNC_REPORT.md \
  vendor/reasonix/compact/internal/agent/compact.go \
  vendor/reasonix/compact/docs/SPEC.md; do
  require_file "$path"
done
require_prefix_match '^src/.+\.ts$'
require_prefix_match '^lib/.+\.js$'
require_prefix_match '^lib/types/.+\.d\.ts$'
require_prefix_match '^docs/.+\.md$'
require_prefix_match '^vendor/reasonix/compact/internal/agent/[^/]+\.go$'
require_prefix_match '^vendor/reasonix/compact/docs/.+\.md$'

ORIGIN_URL="$(git remote get-url origin 2>/dev/null)" || {
  echo "❌ Git remote 'origin' is not configured" >&2
  exit 1
}
REMOTE_BRANCH_COMMIT="$(git ls-remote --heads origin "refs/heads/$BRANCH" | awk 'NR == 1 { print $1 }')"
if [[ "$REMOTE_BRANCH_COMMIT" != "$HEAD_COMMIT" ]]; then
  echo "❌ origin/$BRANCH must already point to $HEAD_COMMIT before npm publish" >&2
  exit 1
fi
LOCAL_TAG_OBJECT="$(git rev-parse "$TAG")"
REMOTE_TAG_OBJECT="$(git ls-remote --tags origin "refs/tags/$TAG" | awk -v tag="refs/tags/$TAG" '$2 == tag { print $1 }')"
if [[ -z "$REMOTE_TAG_OBJECT" || "$REMOTE_TAG_OBJECT" != "$LOCAL_TAG_OBJECT" ]]; then
  echo "❌ origin tag $TAG is missing or differs from the local tag" >&2
  exit 1
fi
echo "✅ release commit, required tree, origin/$BRANCH, and $TAG agree at $HEAD_COMMIT"
echo "✅ origin: $ORIGIN_URL"

echo "🔍 Checking npm login..."
NPM_USER="$(npm_release whoami)" || {
  echo "❌ 未登录 npm，请先运行 npm login，并用 npm whoami 确认" >&2
  exit 1
}
echo "✅ npm user: $NPM_USER"

echo "🔍 Checking that $TARGET is newer than published versions and unused..."
PUBLISHED_VERSIONS="$(npm_release view "$PACKAGE_NAME" versions --json)"
node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  const target = process.argv[1];
  const versions = JSON.parse(raw);
  const published = Array.isArray(versions) ? versions : [versions];
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return match && match.slice(1).map(Number);
  };
  const compare = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  const targetParts = parse(target);
  if (!targetParts) throw new Error(`invalid stable target: ${target}`);
  if (published.includes(target)) throw new Error(`${target} is already published`);
  const stable = published.map(parse).filter(Boolean).sort(compare);
  if (stable.length && compare(targetParts, stable.at(-1)) <= 0) {
    throw new Error(`${target} is not newer than the latest stable version ${published.find(v => JSON.stringify(parse(v)) === JSON.stringify(stable.at(-1)))}`);
  }
  console.log(`✅ target version ${target} is unpublished and newer than the latest stable release`);
});
' "$TARGET" <<<"$PUBLISHED_VERSIONS"

echo "🔍 Release quality gates..."
npm_release run typecheck
npm_release run build
npm_release test

echo "🔍 Checking npm package contents..."
PACK_JSON="$(npm_release pack --dry-run --json --ignore-scripts)"
node -e '
const manifest = JSON.parse(process.argv[1]);
const files = new Set(manifest[0].files.map(file => file.path));
const required = [
  "lib/index.js", "lib/engine.js", "lib/types/index.d.ts", "README.md",
  "docs/MIGRATION_0.1.11_TO_0.2.0.md", "LICENSE", "cordis.patch.yml",
  "cordis.patch.example.yml"
];
const missing = required.filter(file => !files.has(file));
if (missing.length) throw new Error(`npm pack is missing: ${missing.join(", ")}`);
console.log(`✅ npm pack dry-run contains ${files.size} files, including the runtime, declarations, patch, and migration guide`);
' "$PACK_JSON"

WORKTREE_AFTER="$(git status --porcelain --untracked-files=all)"
if [[ -n "$WORKTREE_AFTER" ]]; then
  echo "❌ release checks changed the worktree; review and commit generated output before publishing" >&2
  printf '%s\n' "$WORKTREE_AFTER" >&2
  exit 1
fi

echo "🚀 Publishing $PACKAGE_NAME@$TARGET to npm..."
# All compilation, tests, packing, and remote Git checks have already passed.
# Skip lifecycle scripts so npm publishes the exact artifacts just reviewed.
npm_release publish --access public --ignore-scripts
echo "✅ Published: https://www.npmjs.com/package/$PACKAGE_NAME/v/$TARGET"
