#!/usr/bin/env bash
# Build the standalone Swift Vision CLI used as the secondary OCR fallback.
#
#   ./build_swift.sh          -> produces ./vision_ocr
#
# Requires a Swift toolchain whose version matches the active macOS SDK. On a
# machine where the CommandLineTools compiler and SDK are out of sync you will
# see:
#   error: failed to build module 'Foundation'; this SDK is not supported by
#          the compiler ... Please select a toolchain which matches the SDK.
# Fix it by installing full Xcode (`xcode-select --switch /Applications/Xcode.app`)
# or by updating Command Line Tools so compiler and SDK ship together.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found; install Xcode or Command Line Tools" >&2
  exit 1
fi

echo "building vision_ocr ..."
swiftc -O -o vision_ocr vision_ocr.swift
echo "OK -> $(pwd)/vision_ocr"
