#!/usr/bin/env bash
# Builds and runs the adapter-plus-LTO falsifier (docs/foreign-boundary.md,
# "The contingency"). Produces out/report.md plus the raw evidence it is
# derived from: results-*.txt, *.dis, jni-offsets.txt, env.txt.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -z "${JAVA_HOME:-}" ]]; then
  if command -v asdf >/dev/null 2>&1 && asdf which java >/dev/null 2>&1; then
    JAVA_HOME=$(dirname "$(dirname "$(asdf which java)")")
  else
    JAVA_HOME=$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")
  fi
fi
[[ -f "$JAVA_HOME/include/jni.h" ]] || {
  echo "jni.h not found under JAVA_HOME=$JAVA_HOME" >&2
  exit 1
}

CC=${CC:-clang}
OUT=out
mkdir -p "$OUT/classes"

INCLUDES=(-I"$JAVA_HOME/include" -I"$JAVA_HOME/include/linux")
CFLAGS=(-O2 -g -Wall -Wextra "${INCLUDES[@]}")
LDFLAGS=(-L"$JAVA_HOME/lib/server" -ljvm -Wl,-rpath,"$JAVA_HOME/lib/server")
LTOFLAGS=(-flto=full)
if command -v ld.lld >/dev/null 2>&1; then
  LTOFLAGS+=(-fuse-ld=lld)
fi

# Editor include-path support only; gitignored, regenerated per machine.
printf '%s\n' "${INCLUDES[@]}" >compile_flags.txt

{
  uname -srmo
  "$JAVA_HOME/bin/java" -version 2>&1
  $CC --version | head -1
} >"$OUT/env.txt"

"$JAVA_HOME/bin/javac" -d "$OUT/classes" NTFalsifier.java

$CC "${CFLAGS[@]}" probe_offsets.c -o "$OUT/probe_offsets"
"$OUT/probe_offsets" >"$OUT/jni-offsets.txt"

SRC=(adapter.c kernels_a.c kernels_b.c harness.c)
$CC "${CFLAGS[@]}" "${SRC[@]}" -o "$OUT/falsifier-nolto" "${LDFLAGS[@]}"
$CC "${CFLAGS[@]}" "${LTOFLAGS[@]}" "${SRC[@]}" -o "$OUT/falsifier-lto" \
  "${LDFLAGS[@]}"

objdump -d --no-show-raw-insn "$OUT/falsifier-nolto" >"$OUT/falsifier-nolto.dis"
objdump -d --no-show-raw-insn "$OUT/falsifier-lto" >"$OUT/falsifier-lto.dis"

RUNARGS=(--classpath "$OUT/classes" "$@")
"$OUT/falsifier-nolto" --tag nolto "${RUNARGS[@]}" | tee "$OUT/results-nolto.txt"
"$OUT/falsifier-lto" --tag lto "${RUNARGS[@]}" | tee "$OUT/results-lto.txt"

python3 analyze.py "$OUT" >"$OUT/report.md"
echo "report: $OUT/report.md"
