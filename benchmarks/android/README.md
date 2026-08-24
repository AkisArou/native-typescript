# Android performance comparison

Status: active measurement instrument  
Last revised: 2026-08-24

This benchmark compares four complete, equivalent direct-Android
applications:

- Native TypeScript compiled through ScriptC's C/JNI route;
- Native TypeScript emitted as JVM-targeted Java and compiled to ART bytecode;
- Kotlin compiled directly against `android.jar`;
- plain NativeScript TypeScript using raw Android APIs, with no React, XML UI,
  or cross-platform widget tree in the measured workload.

The second APK is the Direct JVM compiler tier. Its Activity, lifecycle,
timing, logging, platform calls, and every workload originate in checked
TypeScript. The compiler emits JVM-targeted Java, then `javac` and D8 produce
the classes and DEX consumed by ART. It participates in the full workload,
launch, and memory comparison without a handwritten Java benchmark shell.

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
raw `am start -W` output, and uninstalls them during teardown. All four
applications participate in every scenario; the Direct JVM APK implements the
complete declared matrix.

NativeScript is a pinned release build. Its CLI, Android runtime, core,
webpack, Android declarations, TypeScript, and pnpm-hoisting compatibility
inputs are exact entries in the workspace's `nativescript` catalog. The
runner materializes those versions into an isolated staging project because
the NativeScript CLI consumes ordinary semver package fields, then packages
only the x86-64 runtime to match the Native TypeScript artifact under test.

## Workloads

The four readable application implementations contain the same constants. The
Direct route splits some reached language kernels into focused TypeScript
modules, but carries the same constants for the complete matrix. The
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
| Language | `optional-values` | Consume 50,000 scalar and reference optional-result pairs across helper calls, with mixed present/missing arms |
| Language | `map-operations` | Run 50,000 bounded string-key cache updates with `get`, `set`, `has`, `delete`, reinsertion, and optional numeric results |
| Language | `set-operations` | Run 50,000 bounded string membership updates with `add`, `has`, `delete`, reinsertion, `size`, and periodic insertion-order iteration |
| Language | `math-operations` | Run 100,000 deterministic numeric transforms through `floor`, `ceil`, `trunc`, JavaScript `round`, `abs`, `min`, and `max` |
| Language | `number-parsing` | Parse 50,000 bounded triples of base-10 integers, signed fractions, and exponent text through `parseInt`, `parseFloat`, and number conversion |
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
Launch summaries use `WaitTime`, the field current ART emits for all four
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
  applicable cross-implementation ratios. Schema 8 also records the exact
  Kotlin standard-library jars supplied to D8 and each jar's SHA-256 digest;
- one `dumpsys meminfo` snapshot per application and launch round.

The initial harness does not yet claim first-visible-frame timing, tap-input
latency, JNI global-reference counts, or statistical significance. Those need
new instruments. In particular, `am start -W` is labelled as launch
completion rather than being renamed to the stronger first-frame claim.

## Interpretation

The first complete four-application run is recorded in
[record 0044](../../docs/records/0044-first-complete-direct-jvm-matrix.md).
Direct JVM is within 16% of Kotlin for managed dispatch, construction,
same-thread callbacks, returned strings, string operations, byte arrays,
callback payload/capture, and composite screen rows. It wins the measured
string-result, callback-payload, callback-capture, and screen-row comparisons.

The largest Direct JVM gaps in that complete baseline are explicit: fixed
records (48.90x Kotlin),
returned handles (9.89x), optional values (9.20x), sets (8.04x), stable
setters (3.39x), Math (2.88x), maps (2.37x), string arguments (2.07x), arrays
(1.56–1.82x), and number parsing (1.55x). These ratios determine the next
inspection order; they are not assumed causes. Each optimization still needs
a disagreeing semantic observer, host JVM/classfile proof, and unchanged
on-device workload before it is accepted.

The first such inspection found a general closed-calling-convention barrier,
not an expensive record representation. A focused five-round run after
specializing proved integer helper parameters reduced fixed records from
48.90x to 1.56x Kotlin, optional values from 9.20x to 3.12x, sets from 8.04x
to 1.67x, and Math from 2.88x to 1.27x. Public `number` ABI remains `double`.
[Record 0045](../../docs/records/0045-direct-jvm-integer-parameters.md)
contains the complete nine-scenario before/after table and safety proof; the
complete 23-scenario matrix above remains the regression baseline until the
next full run.

The next focused inspection removed allocation from numeric optional unions.
One primitive `long` now carries `number | null | undefined`, including NaN
and negative-zero semantics, through calls, arrays, narrowing, and typed-map
results. Optional lookups fell from 28.69 ns to 1.47 ns (3.12x Kotlin to
0.23x); map operations fell from 97.60 ns to 36.77 ns (2.12x to 1.26x).
Returned handles were also remeasured at 3.19 ns and 1.13x Kotlin after the
earlier integer specialization, disproving the old handle-representation
diagnosis. [Record 0046](../../docs/records/0046-direct-jvm-primitive-number-unions.md)
contains the representation proof and raw five-round reports.

NativeScript's mature V8 runtime wins several pure-language kernels, while
Direct JVM is far faster on the measured Android boundary and callback paths.
That complementary result supports specialization of reached TypeScript
semantics into ART-friendly JVM forms rather than adding a generic JavaScript
dispatcher.

Earlier JNI resource-domain measurements are preserved in
[records 0016–0021](../../docs/records/0016-frame-bounded-native-results.md).
The Direct JVM architecture grows from exact Android calls in
[record 0023](../../docs/records/0023-direct-jvm-android-call.md) through
native subclasses in
[record 0035](../../docs/records/0035-direct-jvm-native-subclasses.md), arrays
in [record 0037](../../docs/records/0037-direct-jvm-specialized-arrays.md),
records in [record 0038](../../docs/records/0038-direct-jvm-fixed-records.md),
and JavaScript-exact number parsing in
[record 0043](../../docs/records/0043-direct-jvm-number-parsing.md). The first
matrix-selected optimization is recorded in
[record 0045](../../docs/records/0045-direct-jvm-integer-parameters.md).
Primitive numeric union specialization is recorded in
[record 0046](../../docs/records/0046-direct-jvm-primitive-number-unions.md).
The subsequent fixed two-value array append removes the Java varargs argument
array from `push(a, b)`; its repeated device result is recorded in
[record 0048](../../docs/records/0048-direct-jvm-fixed-two-value-push.md).
Exact backing-capacity planning for a literal followed immediately by fixed
appends then removes the remaining grow-and-copy without moving the append or
its argument evaluation. The dynamic array lifecycle improves another
26.6%/40.6% and reaches Kotlin parity or better in the repeated runs recorded
in [record 0049](../../docs/records/0049-direct-jvm-array-capacity-planning.md).
A subsequent focused rebaseline shows the scalar setter at 1.06x Kotlin and
two-string arguments at 1.01x, invalidating their old priority rankings.
Short `parseInt` inputs now keep a proved radix in `int` and combine validation
with accumulation. Exact parser vectors remain unchanged while repeated
device runs improve the three-parse workload by 12.1%/15.1%, as recorded in
[record 0050](../../docs/records/0050-direct-jvm-short-integer-parsing.md).
Exact integer and boolean substitutions now enter the final Java string
concatenation without first allocating standalone formatted strings. A
disagreeing adjacent-substitution fixture preserves concatenation semantics;
repeated device runs improve dynamic Android text updates by 22.9%/24.6% and
reach 1.18x/1.09x Kotlin, as recorded in
[record 0051](../../docs/records/0051-direct-jvm-primitive-string-concat.md).

## Research references

- [Android Microbenchmark overview](https://developer.android.com/topic/performance/benchmarking/microbenchmark-overview)
- [Android performance measurement](https://developer.android.com/topic/performance/measuring-performance)
- [Android JNI tips](https://developer.android.com/ndk/guides/jni-tips)
- [NativeScript Android marshalling](https://docs.nativescript.org/guide/android-marshalling)
