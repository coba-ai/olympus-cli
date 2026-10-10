#!/bin/sh
# Install the olympus binary from a GitHub release.
# Usage: install.sh [TAG]   env: OLYMPUS_INSTALL_DIR (default ~/.local/bin)
set -eu

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "olympus install: unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "olympus install: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "olympus install needs curl" >&2
  exit 1
fi

asset="olympus-$os-$arch"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${1:-}" ]; then
  base="https://github.com/coba-ai/olympus-cli/releases/download/$1"
else
  base="https://github.com/coba-ai/olympus-cli/releases/latest/download"
fi
for f in "$asset" SHA256SUMS; do
  curl -fsSL -o "$tmp/$f" "$base/$f" || { echo "olympus install: could not download $base/$f" >&2; exit 1; }
done

want=$(grep "  $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 || true)
[ -n "$want" ] || { echo "olympus install: no checksum for $asset in SHA256SUMS" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else
  got=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
fi
[ "$got" = "$want" ] || { echo "olympus install: checksum mismatch for $asset; nothing installed" >&2; exit 1; }

dir=${OLYMPUS_INSTALL_DIR:-$HOME/.local/bin}
mkdir -p "$dir"
cp "$tmp/$asset" "$dir/.olympus.$$"
chmod 0755 "$dir/.olympus.$$"
mv "$dir/.olympus.$$" "$dir/olympus"
echo "installed $dir/olympus"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "note: $dir is not on your PATH" ;;
esac
