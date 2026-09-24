#!/usr/bin/env bash
# Adapts upstream's CI to the fork. The sync workflow reruns this after every
# rebase and commits the result as the last commit on main, so upstream edits to
# these lines never cause rebase conflicts. Each edit is a no-op if upstream
# renames what it matches.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Blacksmith runners -> GitHub-hosted runners.
# macOS jobs use macos-15: GitHub's macos-26 image rejects electron-builder <26.16.1's
# keychain unlock (electron-userland/electron-builder#10066). Move to macos-26 once
# upstream pins electron-builder 26.16.1 or later.
find .github -name '*.yml' -print0 | xargs -0 sed -i.bak -E \
  -e 's/blacksmith-[0-9]+vcpu-ubuntu-2404/ubuntu-24.04/g' \
  -e 's/blacksmith-[0-9]+vcpu-macos-26/macos-15/g' \
  -e 's/blacksmith-[0-9]+vcpu-windows-2025/windows-2025/g'
find .github -name '*.yml.bak' -delete

# Otter Code ships macOS and Linux only: skip the Windows desktop jobs, let the
# release proceed without them, and stop expecting .exe assets.
perl -0pi -e '
  s/(\n  desktop_win_(?:x64|arm64):\n(?:    .*\n)*?    if: )\$\{\{.*?\}\}/$1\${{ false }}/g;
  s/needs\.desktop_win_(x64|arm64)\.result == \x27success\x27/needs.desktop_win_$1.result != \x27failure\x27/g;
  s/\n[ \t]*echo \x27release-assets\/\*\.exe\x27//g;
' .github/workflows/release.yml
