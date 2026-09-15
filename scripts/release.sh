#!/usr/bin/env bash
# release.sh — standardize releases for opencode-permission-inherit.
#
# A release is: a git tag vX.Y.Z on main whose tree contains a SHA256SUMS
# matching the tagged permission-inherit.ts, plus a GitHub release with
# permission-inherit.ts and SHA256SUMS as assets. Verify pins everything.
#
# Subcommands:
#   check [--tag X]    preflight: clean tree, on main, sync'd with origin,
#                      SHA256SUMS matches the working permission-inherit.ts.
#                      With --tag, also checks the tag doesn't already exist.
#                      Never mutates anything.
#   create --tag X     run check, push, tag, push tag, create the GitHub
#                      release with assets, then verify. Requires the
#                      checksums commit (if any) to already be on main.
#   verify --tag X     post-flight: download release assets and confirm the
#                      plugin asset matches its SHA256SUMS and the tagged file.
#
# All subcommands accept --help; create accepts --dry-run and --yes.

set -euo pipefail

PROG=release.sh
REPO=Dahep/opencode-permission-inherit
PLUGIN_FILE=permission-inherit.ts
SUMS_FILE=SHA256SUMS
TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

usage() {
  cat <<EOF
Manage releases of $REPO.

Usage:
  $PROG check [--tag <vX.Y.Z>]
  $PROG create --tag <vX.Y.Z> [--dry-run] [--yes]
  $PROG verify --tag <vX.Y.Z>
  $PROG --help

Subcommands:
  check    Preflight only. Verifies a clean tree, branch main, an up-to-date
           remote, and that SHA256SUMS matches the working permission-inherit.ts.
           With --tag, also checks the tag doesn't already exist and the
           version matches the pending release. Never mutates anything.
  create   Full release: runs every check, pushes main, tags, pushes the tag,
           creates the GitHub release with both files as assets, then runs
           verify. The checksums commit (if any) must already be on main —
           this script does not commit. Skips phases a previous run already
           completed (resumes after partial failure).

           --dry-run prints the plan and exits 0. --yes skips confirmation.
  verify   Post-flight. Downloads the release assets and the tagged
           $PLUGIN_FILE, and confirms all three agree on the hash. Safe to
           re-run at any time.

Options:
  --tag <vX.Y.Z>   Release tag. Required for create and verify; check without
                   it validates the pending next release.
  --dry-run        (create) print the exact steps, change nothing.
  --yes            (create) skip the interactive confirmation.
  -h, --help       Show this help.

Examples:
  $PROG check
  $PROG check --tag v0.2.0
  $PROG create --tag v0.2.0 --dry-run
  $PROG create --tag v0.2.0
  $PROG verify --tag v0.2.0
  $PROG verify --tag v0.1.0
EOF
}

die() { printf 'Error: %s\n' "$1" >&2; shift; [ $# -gt 0 ] && printf '  %s\n' "$@" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "required tool '$1' not found in PATH"; }

# --- flag parsing -----------------------------------------------------------

cmd=""
tag=""
dry_run=0
assume_yes=0

[ $# -eq 0 ] && { usage >&2; exit 1; }

cmd="$1"; shift
case "$cmd" in
  -h|--help|help) usage; exit 0 ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      [ $# -ge 2 ] || die "--tag requires a value." "  $PROG create --tag v0.2.0"
      tag="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --yes) assume_yes=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option '$cmd $1'." "  $PROG --help" ;;
  esac
done

case "$cmd" in
  check|create|verify) ;;
  *) die "unknown subcommand '$cmd'." "  $PROG --help" ;;
esac

if [ "$cmd" = "create" ] || [ "$cmd" = "verify" ]; then
  [ -n "$tag" ] || die "no tag specified." "  $PROG $cmd --tag v0.2.0" "  Tags look like: v0.1.0, v1.0.0"
fi
if [ -n "$tag" ]; then
  printf '%s' "$tag" | grep -Eq "$TAG_RE" || \
    die "tag '$tag' is not a valid version tag." "  Expected vX.Y.Z, e.g. v0.2.0" "  Existing tags: $(git tag -l | tr '\n' ' ')"
fi

# --- shared environment checks ---------------------------------------------

for tool in git gh sha256sum curl; do need "$tool"; done

need_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository." "  Run from a clone of $REPO."
  [ -f "$PLUGIN_FILE" ] || die "$PLUGIN_FILE not found in cwd." "  Run from the repository root."
}

check_clean_tree() {
  if [ -n "$(git status --porcelain)" ]; then
    die "working tree has uncommitted changes." \
      "  Commit or stash them first: git status --porcelain" \
      "  A release tag must point at committed content only."
  fi
}

check_branch() {
  local branch; branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = "main" ] || die "not on branch main (on '$branch')." \
    "  Releases are cut from main: git checkout main && git pull"
}

check_remote_current() {
  git fetch --quiet origin main 2>/dev/null || die "cannot reach origin to fetch main." \
    "  Check network / ssh: git fetch origin"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    die "local main is not in sync with origin/main." \
      "  git pull --ff-only && git push   # then re-run"
  fi
}

check_checksums() {
  local actual
  actual="$(sha256sum "$PLUGIN_FILE")"
  if ! printf '%s\n' "$actual" | sha256sum --check --strict "$SUMS_FILE" >/dev/null 2>&1; then
    die "$SUMS_FILE does not match the current $PLUGIN_FILE." \
      "  Regenerate in a normal commit first:" \
      "    sha256sum $PLUGIN_FILE > $SUMS_FILE && git commit -am 'checksums' && git push" \
      "  ...then re-run: $PROG $cmd${tag:+ --tag $tag}"
  fi
}

check_tag_free() {
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1 \
     || [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
    die "tag $tag already exists." \
      "  Pick the next version (existing: $(git tag -l | tr '\n' ' '))."
  fi
}

# For verify: read-only against the release assets + local tag content.
verify_released() {
  echo "Verifying release $tag ..."
  local sums_url file_url tmpdir tagged_hash sums_entry
  tmpdir="$(mktemp -d)"

  sums_url="https://github.com/$REPO/releases/download/$tag/$SUMS_FILE"
  file_url="https://github.com/$REPO/releases/download/$tag/$PLUGIN_FILE"

  curl -fsSL "$sums_url" -o "$tmpdir/$SUMS_FILE" 2>/dev/null \
    || { rm -rf "$tmpdir"; die "cannot download $sums_url" "  Does release $tag exist? Try: gh release view $tag -R $REPO"; }
  curl -fsSL "$file_url" -o "$tmpdir/$PLUGIN_FILE" 2>/dev/null \
    || { rm -rf "$tmpdir"; die "cannot download $file_url"; }

  printf 'downloaded %s (%s)\n' "$tag" "$PLUGIN_FILE"

  sums_entry="$(cut -d' ' -f1 "$tmpdir/$SUMS_FILE" | head -1)"
  local asset_hash; asset_hash="$(sha256sum "$tmpdir/$PLUGIN_FILE" | cut -d' ' -f1)"

  if [ "$asset_hash" != "$sums_entry" ]; then
    rm -rf "$tmpdir"
    die "release asset $PLUGIN_FILE hash ($asset_hash) != its own $SUMS_FILE ($sums_entry)." \
        "  The release assets are inconsistent — investigate before installing."
  fi

  tagged_hash="$(git show "$tag:$PLUGIN_FILE" 2>/dev/null | sha256sum | cut -d' ' -f1)" || true

  if [ -n "$tagged_hash" ] && [ "$tagged_hash" != "$sums_entry" ]; then
    rm -rf "$tmpdir"
    die "tagged $PLUGIN_FILE hash ($tagged_hash) != release SHA256SUMS ($sums_entry)." \
      "  The tag content and the release assets diverged. Do not install this release."
  fi
  rm -rf "$tmpdir"
  echo "ok: $tag $sums_entry"
}

# --- create -----------------------------------------------------------------

do_create() {
  need_git_repo
  check_clean_tree
  check_branch
  check_remote_current
  check_checksums

  local sums_hash; sums_hash="$(cut -d' ' -f1 "$SUMS_FILE" | head -1)"

  # Resume support: a previous run may have died after pushing the tag or
  # creating the release. Each phase is skipped if already done.
  local have_tag=0 have_release=0
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1 \
     || [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
    have_tag=1
  fi
  if gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then
    have_release=1
  fi

  if [ "$have_tag" = "1" ]; then
    # Never re-point; confirm the existing tag's content matches the checksums.
    if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1; then
      git fetch --quiet origin "refs/tags/$tag:refs/tags/$tag" \
        || die "tag $tag exists on origin but could not be fetched."
    fi
    local tagged_hash; tagged_hash="$(git show "$tag:$PLUGIN_FILE" | sha256sum | cut -d' ' -f1)"
    if [ "$tagged_hash" != "$sums_hash" ]; then
      die "tag $tag already exists but its $PLUGIN_FILE hash ($tagged_hash)" \
          "differs from the working SHA256SUMS ($sums_hash)." \
          "  Tags are immutable — pick the next version."
    fi
    echo "resume: tag $tag already exists with matching content"
  fi

  if [ "$have_release" = "1" ] && [ "$have_tag" = "1" ]; then
    echo "release $tag already exists — running post-flight verify only"
    verify_released
    echo "already released: $tag"
    echo "url: https://github.com/$REPO/releases/tag/$tag"
    echo "sha256: $sums_hash"
    return 0
  fi

  local last_tag; last_tag="$(git describe --tags --abbrev=0 2>/dev/null || echo '(none)')"

  echo "release plan:"
  echo "  tag:     $tag  (previous: $last_tag)"
  echo "  file:    $PLUGIN_FILE  sha256: $sums_hash"
  if [ "$have_tag" = "1" ]; then
    echo "  steps:   skip tag (exists) → gh release create (assets: $PLUGIN_FILE, $SUMS_FILE) → verify"
    echo "  (resuming an interrupted release)"
  elif [ "$have_release" = "1" ]; then
    die "release $tag exists but tag $tag doesn't — inconsistent state." \
        "  Delete the orphaned release: gh release delete $tag -R $REPO --cleanup-tag"
  else
    echo "  steps:   push main → create tag $tag → push tag → gh release create (assets: $PLUGIN_FILE, $SUMS_FILE) → verify"
  fi

  if [ "$dry_run" = "1" ]; then
    echo "dry-run: no changes made."
    exit 0
  fi

  if [ "$assume_yes" != "1" ]; then
    printf 'create release %s? [y/N] ' "$tag"
    read -r reply
    case "$reply" in y|Y|yes|Yes) ;; *) echo "aborted."; exit 1 ;; esac
  fi

  if [ "$have_tag" != "1" ]; then
    git push origin main
    git tag "$tag"
  fi
  git push origin "$tag"

  if ! gh release create "$tag" "$PLUGIN_FILE" "$SUMS_FILE" --repo "$REPO" \
       --title "$tag" --notes "sha256($PLUGIN_FILE) = $sums_hash"; then
    die "gh release create failed (tag $tag is already pushed)." \
        "  Fix the cause and re-run: create will resume from release creation." \
        "  If the release already exists, verify it:   $PROG verify --tag $tag"
  fi

  verify_released

  echo "released $tag"
  echo "url: https://github.com/$REPO/releases/tag/$tag"
  echo "sha256: $sums_hash"
}

# --- check ------------------------------------------------------------------

do_check() {
  need_git_repo
  check_clean_tree
  check_branch
  check_remote_current
  check_checksums
  if [ -n "$tag" ]; then
    check_tag_free
    echo "ok: ready to release $tag"
  else
    echo "ok: clean, on main, in sync, checksums match. Next step:"
    echo "  $PROG create --tag vX.Y.Z --dry-run"
  fi
}

case "$cmd" in
  check)  do_check ;;
  create) do_create ;;
  verify) need_git_repo; verify_released ;;
esac
