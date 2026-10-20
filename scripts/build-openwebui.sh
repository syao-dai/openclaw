#!/usr/bin/env bash
# Build the Open WebUI image with the local build-robustness patch applied.
#
# The patch (patches/openwebui-build-robustness.patch) is applied to a temporary
# export of the submodule at its pinned commit, so the submodule working tree
# stays clean and the superproject gitlink never drifts.
#
# The openwebui submodule points at upstream open-webui/open-webui (read-only),
# so local Dockerfile changes must live here instead of as a submodule commit:
# a gitlink pointing at a local-only commit would break `git submodule update`
# on a fresh clone.
#
# If the openwebui submodule is bumped and the patch no longer applies, this
# fails loudly. Regenerate it with:
#   git -C submodules/openwebui diff > patches/openwebui-build-robustness.patch
#
# Usage: scripts/build-openwebui.sh [image_tag] [extra docker build flags]
#        (default image tag: openwebui:local)
set -euo pipefail

root=$(git rev-parse --show-toplevel)
patch_file="$root/patches/openwebui-build-robustness.patch"
submodule="$root/submodules/openwebui"
tag=${1:-openwebui:local}
shift || true

[ -f "$patch_file" ] || { echo "missing patch: $patch_file" >&2; exit 1; }
pinned=$(git -C "$submodule" rev-parse --short HEAD)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Export the submodule at its pinned commit (no .git, no local changes).
# (Write the tar to a file first: piping through PowerShell corrupts the bytes.)
git -C "$submodule" archive HEAD > "$tmp/src.tar"
mkdir -p "$tmp/src"
tar -xf "$tmp/src.tar" -C "$tmp/src"

if ! (cd "$tmp/src" && git apply --check "$patch_file"); then
  echo "patch does not apply to openwebui $pinned; fix or regenerate $patch_file" >&2
  exit 1
fi
(cd "$tmp/src" && git apply "$patch_file")

echo "building $tag from openwebui $pinned + $(basename "$patch_file")"
docker build -t "$tag" "$@" "$tmp/src"
