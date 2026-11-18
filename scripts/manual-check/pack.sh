#!/bin/bash
# Build the self-contained Mac check bundle from the working tree (tracked + untracked, minus .gitignore).
# Usage: scripts/manual-check/pack.sh [output-dir]   (default: ./.manual-check)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
out="${1:-.manual-check}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
name=audit-mac-check
mkdir -p "$stage/$name" "$out"

git ls-files -z --cached --others --exclude-standard | grep -zv '^\.manual-check/' |
  while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done |
  xargs -0 -I{} cp --parents -P {} "$stage/$name/"

cp -r scripts/manual-check/bundle/* "$stage/$name/"
chmod +x "$stage/$name"/*.command "$stage/$name/scripts/manual-check/lib.sh"
{
  git rev-parse --short HEAD
  git diff --quiet HEAD -- && echo "(clean)" || echo "(with uncommitted changes)"
} | tr '\n' ' ' >"$stage/$name/COMMIT.txt"

rm -f "$out/$name.zip"
(cd "$stage" && zip -qr "$OLDPWD/$out/$name.zip" "$name")
echo "$out/$name.zip  ($(du -h "$out/$name.zip" | cut -f1))"

# Small add-on for a Mac that already has the full bundle: unzip it over the bundle folder (same layout).
extras="$stage/desktop-check-extras"
mkdir -p "$extras/scripts/manual-check"
cp -r scripts/manual-check/bundle/sample-projects scripts/manual-check/bundle/MANUAL-CHECKLIST.md \
  scripts/manual-check/bundle/3-auto-desktop-check.command "$extras/"
cp scripts/manual-check/desktop-auto-check.mjs "$extras/scripts/manual-check/"
chmod +x "$extras/3-auto-desktop-check.command"
rm -f "$out/desktop-check-extras.zip"
(cd "$stage" && zip -qr "$OLDPWD/$out/desktop-check-extras.zip" desktop-check-extras)
echo "$out/desktop-check-extras.zip  ($(du -h "$out/desktop-check-extras.zip" | cut -f1))"
