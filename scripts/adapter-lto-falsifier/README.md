# Adapter-plus-LTO falsifier

The measurement [`docs/foreign-boundary.md`](../../docs/foreign-boundary.md)
("The contingency") requires **before any compiler expansion for a
platform**: how much of the conservative adapter's price does link-time
optimization already refund? Whatever adapters plus LTO already achieve, the
compiler need not absorb.

## What is compared

Three programs in two shapes, plus one capability program in three carrier
shapes, over a real JVM embedded through the invocation API:

| case | the program | where the shapes differ |
| --- | --- | --- |
| `nonescaping` | call returns an object, one field is read, the value dies inside the iteration | A promotes to a global reference and frames every call; B deletes the local ref at last use |
| `stored` | the returned object outlives the call (ring of 256) | promotion is genuinely required, so both promote; the delta isolates A's per-call frame and handle bookkeeping |
| `fallible` | a useful `int` result with a detailed failure channel (message captured, owned, released) | both detect with one `ExceptionCheck`; capture is a cold path in both — expected to be fully refunded |
| `env` | read the JNI version through the current thread's `JNIEnv*` | lookup reacquires it from the cached `JavaVM` per iteration; scoped reads the reentrant TLS carrier used by the JVM target; passed is the explicit-operand lower bound |

**Variant A** is the contingency adapter: a per-call wrapper in its own
translation unit that cannot see liveness or escape, so it opens a local
frame and promotes every returned object, returning the neutral algebra's
handle (pointer + destructor as data). Built twice: without LTO (the honest
adapter baseline) and with `-flto=full` (what the linker refunds).

**Variant B** is what an escape- and liveness-aware compiler would emit for
the same programs — the code the foreign-boundary design says only the
compiler can choose. `b2` bounds what a batched region could add; it is an
appendix, not a claim.

The `env` trio separates the operation from its carrier. Every arm calls
`JNIEnv->GetVersion`; only lookup calls `JavaVM->GetEnv`. Scoped measures the
narrow target-owned implementation, including its TLS read, while passed
bounds what an invasive explicit ABI operand could achieve. The host result
does not stand in for ART: the Android suite is the admission measurement for
the shipped carrier.

## What is measured

Exactly the four legs the document names, never intermediate IR:

- steady-state benchmarks (median ns/op over reps, after warmup);
- exact dynamic counts of reference and frame operations, via an interposed
  JNI function table (every unwrapped slot traps);
- final-assembly call sites per kernel, with indirect calls labeled by
  function-table offsets **probed from the real `jni.h`** (`probe_offsets.c`)
  rather than hand-written;
- identical-work verification: both variants must produce equal checksums
  and both failure channels must deliver the real exception message.

## Running

```bash
./run.sh                      # defaults: 2M iters × 9 reps, 3M warmup
./run.sh --iters 5000000 --reps 15
```

Requires a JDK (found via `JAVA_HOME`, asdf, or `java` on PATH), clang, and
objdump. Output lands in `out/`: `report.md` plus the raw evidence it is
derived from.

## Known limits

- HotSpot on a desktop host: absolute nanoseconds are not ART numbers. The
  structural result — which operations survive in the final assembly — is
  VM-independent, because calls through the env table are opaque to LTO on
  any VM.
- Single-threaded, matching the first JNI slice (already-attached threads
  only). Global-reference GC-root pressure and global-ref lock contention
  under threads are real costs this instrument does not see; a conclusion
  that the steady-state tax is small does not cover them.
