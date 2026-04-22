#!/usr/bin/env bash
# install.sh — install the floom CLI on Linux or macOS.
#
# Usage:
#   curl -fsSL https://floom.dev/install.sh | bash
#
# What it does:
#   - clones github.com/floomhq/floom to ~/.floom/repo (shallow)
#   - symlinks ~/.floom/repo/cli/floom/bin/floom -> ~/.local/bin/floom
#   - prints instructions to add ~/.local/bin to PATH if missing
#
# To uninstall: rm -rf ~/.floom/repo ~/.local/bin/floom

set -euo pipefail

REPO_URL="${FLOOM_REPO_URL:-https://github.com/floomhq/floom.git}"
BRANCH="${FLOOM_BRANCH:-main}"
INSTALL_ROOT="${FLOOM_INSTALL_ROOT:-$HOME/.floom}"
REPO_DIR="$INSTALL_ROOT/repo"
BIN_DIR="${FLOOM_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/floom"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "install.sh: missing required tool: $1" >&2
    exit 1
  }
}

need git
need curl

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"

if [[ -d "$REPO_DIR/.git" ]]; then
  echo "updating existing clone at $REPO_DIR"
  git -C "$REPO_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
else
  echo "cloning $REPO_URL into $REPO_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

SRC="$REPO_DIR/cli/floom/bin/floom"
if [[ ! -x "$SRC" ]]; then
  chmod +x "$SRC" 2>/dev/null || true
fi

ln -sf "$SRC" "$TARGET"
echo "installed: $TARGET -> $SRC"

if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  cat <<EOF

$BIN_DIR is not on your PATH. Add this to your shell profile:

  export PATH="$BIN_DIR:\$PATH"

Then: floom --help
EOF
else
  echo
  echo "run: floom --help"
fi
