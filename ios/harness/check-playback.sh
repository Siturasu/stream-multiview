#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
CHECK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sv-playback-checks.XXXXXX")
trap 'rm -rf "$CHECK_DIR"' EXIT
swiftc -swift-version 5 -module-cache-path "$CHECK_DIR/module-cache" \
  "$SCRIPT_DIR/../Sources/Core/ChzzkPlaybackEvidence.swift" \
  "$SCRIPT_DIR/playback-checks/main.swift" -o "$CHECK_DIR/check-playback"
"$CHECK_DIR/check-playback"
node "$SCRIPT_DIR/playback-checks/probe.mjs"
