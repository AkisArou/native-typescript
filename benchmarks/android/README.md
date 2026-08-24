# Android performance comparison

Status: active measurement instrument  
Last revised: 2026-08-24

This benchmark compares four complete, equivalent direct-Android
applications:

- Native TypeScript compiled through the JVM target;
- Native TypeScript emitted directly as JVM bytecode;
- Kotlin compiled directly against `android.jar`;
- plain NativeScript TypeScript using raw Android APIs, with no React, XML UI,
  or cross-platform widget tree in the measured workload.

The fourth APK is the direct-JVM compiler tier. Its Activity, lifecycle,
timing, logging, platform calls, and every workload are checked TypeScript
emitted as ART bytecode, so it now participates in the full workload, launch,
and memory comparison without a handwritten Java benchmark shell.

It is separate from the Android acceptance fixture: timings are observations,
never test verdicts.

Run a host-only build first:

```bash
pnpm benchmark:android -- --build-only
```

Run all four APKs on the one attached, authorized x86-64 device:

```bash
pnpm benchmark:android -- --rounds 5
```

For an optimization loop, select one or more workload contracts without
changing their inputs, warmups, samples, comparison implementations, or
checksum validation:

```bash
pnpm benchmark:android -- --scenario managed-class --rounds 5
pnpm benchmark:android -- --scenario string-argument --scenario string-result --rounds 5
```

Repeating `--scenario NAME` is allowed; selecting the same name twice or an
unknown name is an error. A selected run records only those scenarios in its
versioned report. Process launch and memory are measured only when `view-tree`
is selected, because the other kernels do not exercise or claim application
shape. Omitting `--scenario` preserves the complete matrix.

Use `--serial SERIAL` when more than one device is attached and `--output DIR`
to choose the result directory. With no attached device, `--avd NAME` boots a
configured emulator headlessly and shuts it down after the run. By default,
builds and reports go under the
ignored `.native-typescript/benchmarks/android/` directory. `TMPDIR` is set to
`~/.cache/nts-tmp` so Android and ScriptC builds use real disk rather than the
host's `/tmp` tmpfs.

The runner uses the same exclusive device lock as the acceptance lane. It
builds before taking that lock, installs all four packages, asks ART to
compile each with the `speed` filter, rotates their order each round, records
raw `am start -W` output, and uninstalls them during teardown. The three full
applications participate in every scenario; the direct-JVM APK joins only the
ten scenarios it implements.

NativeScript is a pinned release build. Its CLI, Android runtime, core,
webpack, Android declarations, TypeScript, and pnpm-hoisting compatibility
inputs are exact entries in the workspace's `nativescript` catalog. The
runner materializes those versions into an isolated staging project because
the NativeScript CLI consumes ordinary semver package fields, then packages
only the x86-64 runtime to match the Native TypeScript artifact under test.

## Workloads

The three full readable source files contain the same constants. The direct
kernel also carries every constant used by its ten scenarios. The
runner compares those constants to `native-project.ts` and refuses to run if
they drift. That project file also owns a machine-readable scenario catalog. Every
report records each scenario's layer, hotspot, operation unit, sample count,
and expected checksum; the runner derives its execution and summaries from
that catalog rather than from a second handwritten list.

The suite deliberately has both boundary microcases and Android-shaped work.
A composite score would hide whether a result came from JNI mechanics,
framework work, or language-runtime work, while microcases alone would say
little about an application. Android's own microbenchmark guidance recommends
isolating frequently repeated hot work such as data conversion while avoiding
an accidentally cache-only input, so the string input alternates ASCII and
UTF-16 text. NativeScript receives a real Java `byte[]` created with
`Array.create`, as required by its Android marshalling contract, rather than a
JavaScript array that would change the operation.

| Layer | Scenario | Work performed |
| --- | --- | --- |
| Android | `view-tree` | Build and attach 128 `TextView` children; also supplies the process-launch screen |
| Boundary | `light-object` | Construct 50,000 `Rect`s, immediately call `width()`, and let each non-escaping result die |
| Language | `managed-class` | Make 100,000 virtual calls through a base-typed object; each override calls `super`, advances a stateful integer recurrence in a field, and reads a derived field |
| Language | `string-operations` | Apply UTF-16 trim, case conversion, search, slicing, and padding 10,000 times |
| Language | `array-operations` | Run 20,000 dynamic numeric-array lifetimes with growth, indexed mutation/read, search, and pop |
| Language | `array-pipeline` | Run 20,000 captured `map` → `filter` → `reduce` pipelines with intermediate arrays |
| Language | `record-objects` | Run 50,000 fixed-shape object lifetimes with number, string, and boolean fields, mutation, and reads |
| Android | `constructor` | Construct 2,000 `TextView`s and make one scalar call on each |
| Boundary | `setter` | Make 50,000 `TextView.setTextSize` calls on one stable object |
| Boundary | `callback` | Make 50,000 synchronous `Button.callOnClick` deliveries without consuming the payload |
| Boundary | `string-argument` | Pass 20,000 pairs of alternating ASCII and Unicode strings through `TextUtils.equals` |
| Boundary | `string-result` | Receive and consume 10,000 fresh Java strings from `Rect.flattenToString()` |
| Boundary | `byte-array` | Send a 256-byte primitive array through `Base64.encode` and consume the returned array 2,000 times |
| Boundary | `handle-result` | Call `ViewGroup.getChildAt`, null-check the returned object, then call `getId` 32,000 times |
| Boundary | `callback-payload` | Deliver 20,000 click callbacks and consume each delivered `View` through `getId` |
| Boundary | `callback-capture` | Deliver 20,000 clicks while reusing the delivered `View` and a retained captured `Button` through `getId` |
| Android | `text-update` | Format 10,000 changing counter strings and assign each to one `TextView` |
| Composite | `screen-build` | Build 32 nested rows with labels, buttons, dynamic text, scalar setters, and hierarchy edges |

Every repeated scenario warms up three times and then emits seven measured
samples in each process. `SystemClock.elapsedRealtimeNanos()` measures the
loop on the device. A checksum makes a missing callback, bad projection, or
incomplete loop a hard failure rather than a faster result. The launch
`view-tree` case emits one sample per process round.

The matrix covers the currently implemented high-frequency boundary families:
primitive calls, object construction/results, strings in both directions,
primitive arrays in both directions, synchronous callbacks with payload use
and retained state, widget mutation, and programmatic hierarchy construction. It does
not claim coverage of first-frame rendering, touch latency, asynchronous or
foreign-thread callbacks, storage/database APIs, networking, image buffers,
layout/draw passes, or lifecycle teardown; those require different instruments
rather than more loops in this one.

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

- the four signed APKs and their SHA-256 digests;
- the direct-JVM generated Java and a `javap` evidence file showing the exact
  constructor, instance-method, static-method, array, and callback descriptors,
  distinct-string construction, direct listener implementation, and absence
  of a native entry;
- `results.json`, including source revisions and dirty state, toolchain
  versions, device/build identity, the declared hotspot catalog, raw samples,
  launch/workload/memory summaries, direct-JVM evidence coordinates, and the
  applicable cross-implementation ratios;
- one `dumpsys meminfo` snapshot per application and launch round.

The initial harness does not yet claim first-visible-frame timing, tap-input
latency, JNI global-reference counts, or statistical significance. Those need
new instruments. In particular, `am start -W` is labelled as launch
completion rather than being renamed to the stronger first-frame claim.

## Interpretation

The lightweight-object, constructor, and returned-handle scenarios are the
first resource-domain targets. Native TypeScript now keeps both exact non-null
results and nullable results guarded by null tests frame-bounded when an
immutable local is used only by synchronous borrowed native calls. The value
remains a JNI local reference, receives one lexical `DeleteLocalRef`, and never
enters a managed handle cell or managed nullable-union box. Any storage,
capture, suspension, callback ownership, or other unsupported use stays on the
stable global-reference path. `light-object` exposes the non-null mechanism;
`handle-result` exposes its nullable sibling; `constructor` and `view-tree` say
whether a real widget application notices.

The scalar, string, byte-array, returned-handle, and callback cases prevent one
resource improvement from being misreported as a general JNI improvement.
They identify separate costs that need their own evidence before string
residency, callback-token changes, or call fusion is admitted. A scoped
`JNIEnv *` carrier now removes repeated acquisition inside one callback or
owner turn; the Android and composite cases remain the check that an isolated
boundary saving is visible once framework work surrounds it. Ordinary short
string arguments now stage UTF-16 in their native frame instead of allocating
a temporary heap buffer, while returned Java strings borrow JNI's UTF-16 view
and allocate only their final UTF-8 owner. The exact mechanics and five-round
measurement are recorded in
[record 0021](../../docs/records/0021-frame-local-jvm-string-bridge.md).
The experimental direct-JVM route removes the JNI boundary from the string
kernel and now keeps `Rect` construction plus immediate instance reuse on ART
as an ordinary Java reference. It also accepts the platform-created Activity
as a concrete externally supplied Java parameter, uses its checked identity
upcast to construct a `TextView`, and invokes repeated setters directly on
that stable receiver. Externally called TypeScript bodies are explicit
executable roots rather than fake module-initializer calls, and host-supplied
native types enter the native type closure without selecting an unrelated
binding. Its first static-call proof is recorded in
[record 0023](../../docs/records/0023-direct-jvm-android-call.md); the object
representation, exact bytecode evidence, and matched device result are in
[record 0024](../../docs/records/0024-direct-jvm-object-calls.md); the
host-supplied receiver and stable-setter result are in
[record 0025](../../docs/records/0025-direct-jvm-stable-receiver.md). Proved
signed-integer locals now remove the remaining `ToInt32` and truthiness calls
from the setter and string loops; their bytecode and matched parity result are
in [record 0026](../../docs/records/0026-proved-jvm-integer-locals.md). Java
strings and exact nullable native handles now remain unboxed ART references;
the two added kernels, bytecode proof, and matched device results are in
[record 0027](../../docs/records/0027-direct-jvm-reference-values.md). Direct
`Uint8Array` parameters and results now remain Java `byte[]` references; the
unchanged Base64 loop, exact bytecode proof, and matched device result are in
[record 0028](../../docs/records/0028-direct-jvm-byte-arrays.md). Same-thread
callback delivery now also stays in ART: the generated interface shell is
replaced by a Java listener whose registration arm calls the reached
TypeScript handler directly, while an idempotent Java connection preserves
cancellation. Its stated-and-verified class contract, bytecode proof, and
3.60 ns device median are in
[record 0029](../../docs/records/0029-direct-jvm-callbacks.md). The delivered
object can now be null-checked and used for another Android call
without leaving ART; the matched payload result is in
[record 0030](../../docs/records/0030-direct-jvm-callback-payloads.md).
Captured values now live in exact Java fields or typed mutable holders owned
by that registration; the aliasing proof and matched measurement are in
[record 0031](../../docs/records/0031-direct-jvm-callback-captures.md). These
are joined by ordinary managed TypeScript classes whose fields, inheritance,
`super`, and virtual calls stay in ART; the disagreeing recurrence and matched
2.17 ns first device median are in
[record 0032](../../docs/records/0032-direct-jvm-managed-classes.md). Proved
compiler-private and override-family returns now keep an integer JVM
descriptor; the controlled 36.0% reduction to 1.30 ns per dispatch is in
[record 0034](../../docs/records/0034-proved-jvm-integer-returns.md). These are
joined by direct native subclasses: platform virtual dispatch, exact `super`,
instance fields on the Java receiver, and terminal lifecycle lowering now
compile without JNI, with the two-dispatch peer proof recorded in
[record 0035](../../docs/records/0035-direct-jvm-native-subclasses.md). These
now compose the complete TypeScript-owned benchmark Activity. Specialized
arrays and primitive-signature function values are recorded in
[record 0037](../../docs/records/0037-direct-jvm-specialized-arrays.md), and
fixed-shape records with exact Java fields are recorded in
[record 0038](../../docs/records/0038-direct-jvm-fixed-records.md). Their
on-device array and record measurements are still pending. Scenario-selective
runs and the first rejected managed-method candidate are recorded in
[record 0033](../../docs/records/0033-selective-android-performance-runs.md).

The original two-way observation is preserved in
[record 0014](../../docs/records/0014-first-android-kotlin-baseline.md). The
first three-way Native TypeScript/Kotlin/NativeScript baseline is recorded in
[record 0015](../../docs/records/0015-first-android-nativescript-baseline.md).
The first compiler-selected resource optimization and its unchanged-workload
remeasurement are recorded in
[record 0016](../../docs/records/0016-frame-bounded-native-results.md).
The expanded hotspot matrix, its research basis, and first five-round result
are recorded in
[record 0017](../../docs/records/0017-android-hotspot-matrix.md).
The nullable returned-handle optimization and its unchanged-workload
remeasurement are recorded in
[record 0018](../../docs/records/0018-nullable-frame-bounded-results.md).
The exact `GetEnv`/TLS/explicit-operand carrier measurement, the decision to
keep the implementation target-owned, and its ART before/after result are
recorded in
[record 0019](../../docs/records/0019-scoped-jni-environment-capability.md).
The frame-bounded callback-payload selection and its matched result are
recorded in
[record 0020](../../docs/records/0020-frame-bounded-callback-payloads.md).
The frame-local JVM string bridge and its matched three-way result are recorded
in [record 0021](../../docs/records/0021-frame-local-jvm-string-bridge.md).
The first direct-JVM Android member and its matched four-way result are recorded
in [record 0023](../../docs/records/0023-direct-jvm-android-call.md).
Direct-JVM constructor and instance calls over concrete Java references are
recorded in [record 0024](../../docs/records/0024-direct-jvm-object-calls.md).
Direct-JVM host-supplied objects, checked handle upcasts, and the stable setter
measurement are recorded in
[record 0025](../../docs/records/0025-direct-jvm-stable-receiver.md).
Proved JVM integer locals and the first Kotlin-parity direct setter result are
recorded in
[record 0026](../../docs/records/0026-proved-jvm-integer-locals.md).
Direct-JVM string and nullable-handle representations are recorded in
[record 0027](../../docs/records/0027-direct-jvm-reference-values.md).
Direct-JVM byte-array residency is recorded in
[record 0028](../../docs/records/0028-direct-jvm-byte-arrays.md).
Direct same-thread callbacks are recorded in
[record 0029](../../docs/records/0029-direct-jvm-callbacks.md).
Direct callback object payloads are recorded in
[record 0030](../../docs/records/0030-direct-jvm-callback-payloads.md).
Direct callback captures are recorded in
[record 0031](../../docs/records/0031-direct-jvm-callback-captures.md).
Direct managed classes are recorded in
[record 0032](../../docs/records/0032-direct-jvm-managed-classes.md).
Proved internal JVM integer returns are recorded in
[record 0034](../../docs/records/0034-proved-jvm-integer-returns.md).
Specialized Direct JVM arrays and function values are recorded in
[record 0037](../../docs/records/0037-direct-jvm-specialized-arrays.md).
Fixed-shape Direct JVM records are recorded in
[record 0038](../../docs/records/0038-direct-jvm-fixed-records.md).

## Research references

- [Android Microbenchmark overview](https://developer.android.com/topic/performance/benchmarking/microbenchmark-overview)
- [Android performance measurement](https://developer.android.com/topic/performance/measuring-performance)
- [Android JNI tips](https://developer.android.com/ndk/guides/jni-tips)
- [NativeScript Android marshalling](https://docs.nativescript.org/guide/android-marshalling)
