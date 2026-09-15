#!/usr/bin/env bash
# install.sh — hash-verified install of opencode-permission-inherit.
#
# Downloads permission-inherit.ts from a pinned GitHub release and verifies
# it against the release's SHA256SUMS asset before placing it in a plugins
# directory. Fails closed: a hash mismatch aborts and leaves nothing behind.
#
# Pin discipline lives in the consumer repo: store the tag and the expected
# sha256 next to the install invocation, and commit any upgrade as a
# two-line diff (tag + hash) — that diff is the review unit.

set -euo pipefail

PROG=install.sh
REPO=Dahep/opencode-permission-inherit
PLUGIN_FILE=permission-inherit.ts
SUMS_FILE=SHA256SUMS
DEFAULT_DIR="$HOME/.config/opencode/plugins"

usage() {
  cat <<EOF
Install $PLUGIN_FILE from a pinned release of $REPO.

Usage:
  $PROG --tag <vX.Y.Z> --hash <sha256> [--dir <plugins-dir>] [--force] [--dry-run]
  $PROG --help

Required:
  --tag <vX.Y.Z>    Release tag to install, e.g. v0.2.0. Pin it; never
                    install from a moving ref.
  --hash <sha256>   Expected sha256 of $PLUGIN_FILE, from the release
                    notes / SHA256SUMS, as pinned in your repo. Install
                    aborts if the downloaded file doesn't match.

Options:
  --dir <path>      Target plugins directory (default: $DEFAULT_DIR).
                    Created if missing. For project-local install use a
                    path like ./.opencode/plugins.
  --force           Overwrite an existing installation. Without it, an
                    existing file is left untouched and the command exits 0
                    (idempotent re-runs are safe).
  --dry-run         Show what would be installed, verify nothing, change
                    nothing.
  -h, --help        Show this help.

Exit codes:
  0 installed (or already installed without --force)
  1 usage error / network failure / hash mismatch (fail closed)

Examples:
  # first install, global
  $PROG --tag v0.1.0 --hash 48756392a405094817dc15ef881bc57dd055649cba177077ede824344984138d

  # preview, then install for one project
  $PROG --tag v0.1.0 --hash 4875...38d --dir ./.opencode/plugins --dry-run
  $PROG --tag v0.1.0 --hash 4875...38d --dir ./.opencode/plugins

  # upgrade a pinned install (after re-pinning in your repo)
  $PROG --tag v0.2.0 --hash <new-sha256> --force
EOF
}

die() { printf 'Error: %s\n' "$1" >&2; shift; [ $# -gt 0 ] && printf '  %s\n' "$@" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "required tool '$1' not found in PATH"; }

hash_of() { sha256sum "$1" | cut -d' ' -f1; }

tag=""
hash=""
dir=""
force=0
dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      [ $# -ge 2 ] || die "--tag requires a value." "  $PROG --tag v0.2.0 --hash <sha256>"
      tag="$2"; shift 2 ;;
    --hash)
      [ $# -ge 2 ] || die "--hash requires a value." "  $PROG --tag v0.2.0 --hash <sha256>"
      hash="$2"; shift 2 ;;
    --dir)
      [ $# -ge 2 ] || die "--dir requires a value." "  $PROG --tag v0.2.0 --hash <sha256> --dir <path>"
      dir="$2"; shift 2 ;;
    --force) force=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) die "unknown option '$1'." "  $PROG --help" ;;
  esac
done

[ -n "$tag" ] || die "no --tag specified." "  $PROG --tag v0.2.0 --hash <sha256>"
[ -n "$hash" ] || die "no --hash specified." \
  "  Pin the sha256 from the release so installs are tamper-checked:" \
  "    gh release view $tag -R $REPO --json body -q .body"
printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || \
  die "tag '$tag' is not a valid version tag." "  Expected vX.Y.Z, e.g. v0.2.0"
printf '%s' "$hash" | grep -Eq '^[0-9a-f]{64}$' || \
  die "hash '$hash' is not a sha256 (64 hex chars)." \
    "  Get the pinned hash from the release notes or your repo's pin file."
[ -n "$dir" ] || dir="$DEFAULT_DIR"

for tool in curl sha256sum; do need "$tool"; done

base="https://github.com/$REPO/releases/download/$tag"

if [ "$dry_run" = "1" ]; then
  echo "dry-run: would install $base/$PLUGIN_FILE"
  echo "  → $dir/$PLUGIN_FILE  (sha256 pinned: $hash)"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$base/$PLUGIN_FILE" -o "$tmp/$PLUGIN_FILE" 2>/dev/null \
  || die "cannot download $base/$PLUGIN_FILE" \
    "  Does release $tag exist? Try: gh release view $tag -R $REPO" \
    "  Nothing was installed; a partial download is treated as a failure."

# Cross-check the release's own SHA256SUMS asset. Fail closed when it
# contradicts the file; a missing SUMS asset falls through to the pin check.
if curl -fsSL "$base/$SUMS_FILE" -o "$tmp/$SUMS_FILE" 2>/dev/null && [ -s "$tmp/$SUMS_FILE" ]; then
  ( cd "$tmp" && sha256sum --check --strict "$SUMS_FILE" ) \
    || die "release asset $PLUGIN_FILE does not match the release's own $SUMS_FILE." \
        "  Nothing was installed. The release is inconsistent out of band."
else
  printf 'warning: release has no %s asset; relying on the pinned hash only.\n' "$SUMS_FILE" >&2
fi

actual="$(hash_of "$tmp/$PLUGIN_FILE")"
if [ "$actual" != "$hash" ]; then
  die "sha256 mismatch for $tag." \
    "  pinned:  $hash" \
    "  actual:  $actual" \
    "  Nothing was installed. Do not update the pin to match unless you" \
    "  have verified the new release out of band."
fi

if [ -e "$dir/$PLUGIN_FILE" ] && [ "$force" != "1" ]; then
  existing="$(hash_of "$dir/$PLUGIN_FILE")"
  if [ "$existing" = "$hash" ]; then
    echo "already installed: $dir/$PLUGIN_FILE ($hash)"
    exit 0
  fi
  die "already installed with different content: $dir/$PLUGIN_FILE" \
    "  pinned: $hash" \
    "  on disk: $existing" \
    "  Re-run with --force to overwrite, or inspect the file first."
fi

mkdir -p "$dir"
mv "$tmp/$PLUGIN_FILE" "$dir/$PLUGIN_FILE"
chmod 644 "$dir/$PLUGIN_FILE"

echo "installed $PLUGIN_FILE $tag → $dir/$PLUGIN_FILE"
echo "sha256: $hash"
