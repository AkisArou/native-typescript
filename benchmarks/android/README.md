# Android performance comparison

Status: first measurement slice  
Last revised: 2026-08-22

This benchmark compares three equivalent direct-Android applications:

- Native TypeScript compiled through the JVM target;
- Kotlin compiled directly against `android.jar`;
- plain NativeScript TypeScript using raw Android APIs, with no React, XML UI,
  or cross-platform widget tree in the measured workload.

It is separate from the Android acceptance fixture: timings are observations,
never test verdicts.

Run a host-only build first:

```bash
pnpm benchmark:android -- --build-only
```

Run all three applications on the one attached, authorized x86-64 device:

```bash
pnpm benchmark:android -- --rounds 5
```

Use `--serial SERIAL` when more than one device is attached and `--output DIR`
to choose the result directory. With no attached device, `--avd NAME` boots a
configured emulator headlessly and shuts it down after the run. By default,
builds and reports go under the
ignored `.native-typescript/benchmarks/android/` directory. `TMPDIR` is set to
`~/.cache/nts-tmp` so Android and ScriptC builds use real disk rather than the
host's `/tmp` tmpfs.

The runner uses the same exclusive device lock as the acceptance lane. It
builds before taking that lock, installs all three packages, asks ART to
compile each with the `speed` filter, rotates their order each round, records
raw `am start -W` output, and uninstalls them during teardown.

NativeScript is a pinned release build. Its CLI, Android runtime, core,
webpack, Android declarations, TypeScript, and pnpm-hoisting compatibility
inputs are exact entries in the workspace's `nativescript` catalog. The
runner materializes those versions into an isolated staging project because
the NativeScript CLI consumes ordinary semver package fields, then packages
only the x86-64 runtime to match the Native TypeScript artifact under test.

## Workloads

All three readable source files contain the same constants. The runner
compares those constants to `native-project.ts` and refuses to run if they
drift.

| Scenario | Work performed |
| --- | --- |
| `view-tree` | Build and attach 128 `TextView` children; also supplies the process-launch screen |
| `light-object` | Construct 50,000 `Rect`s and call one trivial method on each |
| `constructor` | Construct 2,000 `TextView`s and make one scalar call on each |
| `setter` | Make 50,000 `TextView.setTextSize` calls on one object |
| `callback` | Make 50,000 synchronous `Button.callOnClick` deliveries |

The four repeated scenarios warm up three times and then emit seven measured
samples in each process. `SystemClock.elapsedRealtimeNanos()` measures the
loop on the device. A checksum makes a missing callback or incomplete loop a
hard failure rather than a faster result.

`process-start` means `am force-stop` followed by `am start -W`; it is a new
process with warm filesystem caches, not a claim that the whole device is
cold. `warm-foreground` means returning an existing Activity from Home.
Launch summaries use `WaitTime`, the field current ART emits for all three
activity implementations, and preserve `TotalTime`, launch state, and the
complete raw result when the platform supplies them.

After every completion line the runner waits briefly and proves that the
application process is still alive. This prevents a workload that logs and
then crashes during view attachment from being accepted as a fast sample; a
failure includes Android's crash buffer.

## Output

Each run directory contains:

- the three signed APKs and their SHA-256 digests;
- `results.json`, including source revisions and dirty state, toolchain
  versions, device/build identity, raw samples, launch/workload/memory
  summaries, and NTS/Kotlin, NativeScript/Kotlin, and
  NTS/NativeScript ratios;
- one `dumpsys meminfo` snapshot per application and launch round.

The initial harness does not yet claim first-visible-frame timing, tap-input
latency, JNI global-reference counts, or statistical significance. Those need
new instruments. In particular, `am start -W` is labelled as launch
completion rather than being renamed to the stronger first-frame claim.

## Interpretation

The lightweight-object and constructor scenarios are the first resource-domain
targets. Today Native TypeScript promotes every returned object to a global
JNI reference and a managed handle cell. `light-object` exposes that mechanism
with little platform work around it; `constructor` and `view-tree` say whether
a real widget application notices. After frame-bounded results land, their
checksums and Kotlin workloads must remain unchanged.

The setter and callback scenarios prevent a constructor improvement from
being misreported as a general JNI improvement. They identify separate costs
that need their own evidence before `JNIEnv *` propagation, callback-token
changes, or call fusion is admitted.

The original two-way observation is preserved in
[record 0014](../../docs/records/0014-first-android-kotlin-baseline.md). The
first three-way Native TypeScript/Kotlin/NativeScript baseline is recorded in
[record 0015](../../docs/records/0015-first-android-nativescript-baseline.md).
