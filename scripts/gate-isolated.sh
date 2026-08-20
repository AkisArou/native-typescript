#!/usr/bin/env bash
# Gate a commit candidate in an isolated worktree, immune to the other
# session's in-flight edits.
#
# Two sessions share this working tree. A `pnpm test` run here chases
# whichever session is mid-edit — four incidents on 2026-08-20 alone — so the
# committing session gates the exact state it is about to commit, elsewhere:
#
#   git add <explicit paths>        # stage exactly the candidate
#   git diff --cached --stat        # review: nothing swept from the peer
#   scripts/gate-isolated.sh        # gates HEAD + the staged changes
#   git commit                      # commits the index that was gated
#
# What it does:
#   * new worktree at HEAD, with the submodule at its RECORDED pointer —
#     fetched from this tree's local clone, so unpushed fork commits resolve;
#     pass a fork SHA as the first argument to gate a co-landing pair (a fork
#     commit plus the parent changes that require it) instead;
#   * applies the STAGED changes (and only those; the peer's unstaged work
#     never enters the gate); the submodule gitlink itself is excluded — the
#     fork-SHA argument is how a pointer bump rides along;
#   * builds the fork compiler once, BEFORE the suite, because in a cold
#     worktree several lanes otherwise race to build it concurrently and
#     trip over each other's partial dist — a false red that looks like a
#     lane failure but is a build race;
#   * runs the full gate with TMPDIR on a real filesystem.
#
# NT_GATE_KEEP=1 keeps the worktree on failure for inspection.

set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
worktree="$HOME/.cache/nt-gate-wt-$$"
tmpdir="${TMPDIR:-$HOME/.cache/nt-tmpdir}"
mkdir -p "$tmpdir"

echo "gate-isolated: HEAD $(git rev-parse --short HEAD), worktree $worktree"
git worktree add "$worktree" HEAD >/dev/null

status=1
cleanup() {
  if [ "$status" -ne 0 ] && [ "${NT_GATE_KEEP:-0}" = 1 ]; then
    echo "gate-isolated: kept failing worktree at $worktree" >&2
    return
  fi
  git worktree remove --force "$worktree" 2>/dev/null || true
  git worktree prune
}
trap cleanup EXIT

gitlink=${1:-$(git ls-tree HEAD third_party/scriptc | awk '{print $3}')}
git -C "$worktree" submodule update --init --recursive >/dev/null 2>&1 || true
if ! git -C "$worktree/third_party/scriptc" cat-file -e "$gitlink" 2>/dev/null; then
  echo "gate-isolated: fetching fork commit $gitlink from the local clone"
  # A bare unpushed SHA is refused as "not our ref" unless it sits at a ref
  # tip, so fall back to fetching every local branch tip and trying again.
  git -C "$worktree/third_party/scriptc" fetch \
    "$root/third_party/scriptc" "$gitlink" >/dev/null 2>&1 ||
    git -C "$worktree/third_party/scriptc" fetch "$root/third_party/scriptc" \
      "+refs/heads/*:refs/remotes/gate-local/*" >/dev/null 2>&1
  if ! git -C "$worktree/third_party/scriptc" cat-file -e "$gitlink" 2>/dev/null; then
    echo "gate-isolated: fork commit $gitlink is not in the local clone" >&2
    exit 2
  fi
fi
if [ -n "${1:-}" ]; then
  echo "gate-isolated: gating with fork override $gitlink"
  git -C "$worktree/third_party/scriptc" checkout --detach "$gitlink" >/dev/null 2>&1
else
  git -C "$worktree" submodule update --recursive >/dev/null
fi

patch=$(mktemp "$tmpdir/nt-gate-candidate.XXXXXX.patch")
# NT_GATE_PATHS restricts the candidate to the named pathspecs. The index is
# shared between sessions, so a peer's partial stage (half of a multi-file
# change) would otherwise ride into the gate and false-red it; this gates
# exactly what the pathspec commit will take.
if [ -n "${NT_GATE_PATHS:-}" ]; then
  # shellcheck disable=SC2086
  git diff --binary --cached -- $NT_GATE_PATHS >"$patch"
else
  git diff --binary --cached -- . ':(exclude)third_party/scriptc' >"$patch"
fi
if [ -s "$patch" ]; then
  echo "gate-isolated: applying staged candidate ($(git apply --stat "$patch" | tail -1 | sed 's/^ *//'))"
  git -C "$worktree" apply --index "$patch"
else
  echo "gate-isolated: nothing staged; gating HEAD as it stands"
fi
rm -f "$patch"

if (
  cd "$worktree"
  pnpm install >/dev/null
  pnpm scriptc:install >/dev/null
  # Build the fork compiler once before the suite: in a cold worktree the
  # lanes that need it otherwise each start the build concurrently and read
  # one another's partial dist, failing on nothing real.
  pnpm --dir third_party/scriptc --filter @scriptc/compiler build >/dev/null
  TMPDIR="$tmpdir" pnpm test
); then
  status=0
else
  status=$?
fi
exit "$status"
