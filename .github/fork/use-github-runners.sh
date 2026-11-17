#!/usr/bin/env bash
# Points this fork's workflows at GitHub-hosted runners: Blacksmith needs a GitHub organization,
# and this fork is a personal account. Idempotent; re-run it after each upstream integration.
set -euo pipefail
cd "$(dirname "$0")/../workflows"

# Arm before plain Ubuntu: "ubuntu-2404" is a prefix of "ubuntu-2404-arm".
# macOS 27 has no "macos-27" label on GitHub; its image is named for its Xcode.
# stickydisk is Blacksmith-only; actions/cache takes the same key and path inputs.
sed -i -E \
  -e 's/blacksmith-[0-9]+vcpu-ubuntu-2404-arm/ubuntu-24.04-arm/g' \
  -e 's/blacksmith-[0-9]+vcpu-ubuntu-2404/ubuntu-24.04/g' \
  -e 's/blacksmith-[0-9]+vcpu-macos-27/xcode-27/g' \
  -e 's/blacksmith-[0-9]+vcpu-macos-26/macos-26/g' \
  -e 's/blacksmith-[0-9]+vcpu-windows-2025/windows-2025/g' \
  -e 's#/etc/apt/blacksmith-ubuntu-mirrors\.txt ##g' \
  -e 's#uses: useblacksmith/stickydisk@[0-9a-f]+( \# v[0-9.]+)?#uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 \# v6.1.0#g' \
  ./*.yml

if grep -nE 'blacksmith' ./*.yml | grep -v '# blacksmith-'; then
  echo "Blacksmith references remain; extend this script." >&2
  exit 1
fi
