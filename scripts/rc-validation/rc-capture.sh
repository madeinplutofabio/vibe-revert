#!/usr/bin/env bash
# RC beta-validation capture/compare. Run at the fixture repo root (Git Bash on Windows).
#
# Captures the four project-file-state dimensions (binary + NUL-safe + filename-safe) and compares
# two checksum-verified captures. Ignored paths (.viberevert/, node_modules/, caches) are excluded
# via git --exclude-standard; a run preflight (see rc-validation-protocol.md) must independently
# confirm .viberevert/ is ignored.
#
#   rc-capture.sh capture <out-dir>          # <out-dir> must NOT exist and must be OUTSIDE the worktree
#   rc-capture.sh compare <before> <after>   # verifies both captures, then compares the four dimensions
set -euo pipefail

die() { echo "rc-capture: $*" >&2; exit 1; }

worktree_root() { git rev-parse --show-toplevel 2>/dev/null || die "not inside a git worktree"; }

# Refuse an output dir that already exists or sits inside the fixture worktree (which would
# contaminate the untracked comparison). Require its parent to already exist.
require_safe_out() {
  local out="$1" absout absroot parent
  [ -e "$out" ] && die "output dir already exists (never reuse/overwrite): $out"
  parent=$(dirname -- "$out")
  absout=$(cd "$parent" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename -- "$out")") \
    || die "parent dir does not exist: $parent"
  absroot=$(cd "$(worktree_root)" && pwd -P)
  case "$absout/" in
    "$absroot/"*) die "output dir is inside the fixture worktree: $absout" ;;
  esac
}

capture() {
  local out="$1" f b64 size hash
  require_safe_out "$out"
  mkdir "$out"   # not -p: parent must already exist, dir must be new
  git rev-parse HEAD                                      > "$out/HEAD.txt"
  git diff --cached --binary --no-ext-diff --no-textconv  > "$out/staged.diff"
  git diff          --binary --no-ext-diff --no-textconv  > "$out/unstaged.diff"
  git status --porcelain=v1 -z                            > "$out/status-porcelain.z"   # supplementary (NUL-safe)
  # Untracked manifest: base64(path) TAB size TAB sha256  (symlinks: base64(path) TAB "symlink" TAB sha256(target))
  # base64-encoding the path keeps records tab/newline/space-safe; NUL-delimited input; deterministic sort.
  : > "$out/untracked-manifest.txt"
  while IFS= read -r -d '' f; do
    b64=$(printf '%s' "$f" | base64 | tr -d '\n')
    if [ -L "$f" ]; then
      hash=$(readlink -- "$f" | sha256sum | cut -d' ' -f1)
      printf '%s\tsymlink\t%s\n' "$b64" "$hash" >> "$out/untracked-manifest.txt"
    elif [ -f "$f" ]; then
      size=$(wc -c < "$f" | tr -d ' ')
      hash=$(sha256sum -- "$f" | cut -d' ' -f1)
      printf '%s\t%s\t%s\n' "$b64" "$size" "$hash" >> "$out/untracked-manifest.txt"
    else
      die "untracked path is neither a regular file nor a symlink: $f"
    fi
  done < <(git ls-files -z --others --exclude-standard)
  LC_ALL=C sort "$out/untracked-manifest.txt" -o "$out/untracked-manifest.txt"
  ( cd "$out" && sha256sum -- HEAD.txt staged.diff unstaged.diff untracked-manifest.txt status-porcelain.z > sha256sums.txt )
  echo "captured -> $out"
}

verify() { ( cd "$1" && sha256sum -c --status sha256sums.txt ) || die "capture checksum verification failed: $1"; }

compare() {
  local before="$1" after="$2" exact=1 dim
  verify "$before"
  verify "$after"
  for dim in HEAD.txt staged.diff unstaged.diff untracked-manifest.txt; do
    if cmp -s "$before/$dim" "$after/$dim"; then printf 'MATCH     %s\n' "$dim"
    else printf 'MISMATCH  %s\n' "$dim"; exact=0; fi
  done
  if cmp -s "$before/status-porcelain.z" "$after/status-porcelain.z"; then
    printf '(suppl.)  porcelain: match\n'
  else
    printf '(suppl.)  porcelain: differ\n'
  fi
  if [ "$exact" -eq 1 ]; then echo "Project-file state exact: yes"; else echo "Project-file state exact: NO"; return 1; fi
}

case "${1:-}" in
  capture) shift; [ "$#" -eq 1 ] || die "usage: rc-capture.sh capture <out-dir>"; capture "$1" ;;
  compare) shift; [ "$#" -eq 2 ] || die "usage: rc-capture.sh compare <before> <after>"; compare "$1" "$2" ;;
  *) echo "usage: rc-capture.sh capture <out-dir>          # at fixture root; out-dir OUTSIDE worktree, must not exist"
     echo "       rc-capture.sh compare <before> <after>"; exit 2 ;;
esac
