#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ios_dir=$(dirname "$script_dir")
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/stream-multiview-native-fetch.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM

swiftc \
  -swift-version 5 \
  -module-cache-path "$build_dir/module-cache" \
  -o "$build_dir/native-fetch-regression" \
  "$ios_dir/Sources/Core/ViewerConfiguration.swift" \
  "$ios_dir/Sources/Core/WebSessionCookies.swift" \
  "$ios_dir/Sources/Core/NativeBridge.swift" \
  "$script_dir/native_fetch_regression.swift" \
  -framework WebKit \
  -framework AppKit

"$build_dir/native-fetch-regression"
