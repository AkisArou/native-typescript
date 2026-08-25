# 0055 — Refresh the complete Android performance matrix

Status: complete four-application measurement  
Recorded: 2026-08-25

The README's performance table still showed the original 23-scenario Direct
JVM baseline. Records 0045–0054 documented later compiler improvements and
focused runs, but a reader could not see one current, internally comparable
matrix. Workload schema 14 now contains 30 scenarios, including four string
sub-probes and three numeric-parser sub-probes, so all four applications were
rebuilt and measured together again.

## Method

The run used the pinned API 37 x86-64 Pixel 10 Pro AVD and ART `speed`
compilation. Three cyclic process rounds produced 21 samples for every
repeated workload and three samples for `view-tree`. Every application was
force-stopped between scenario rounds. Each sample's independently calculated
checksum passed.

The measured source identities were:

- parent `828a730508741c98221b3bc5d110153e8ada626d`;
- ScriptC fork `58b210bb3ed2b43e5d7940f2ed78382669afc573`;
- workload schema 14;
- 30 scenarios;
- four successful APK compilations.

The report also records content digests for every benchmark source. The parent
worktree named two unrelated documentation edits at measurement time; neither
is an input to any benchmark application.

## Result

Direct JVM is at or within 22% of Kotlin for all 30 measured scenarios. The
largest normalized gaps are not the largest costs:

| Scenario | Direct JVM | Kotlin | Direct/Kotlin | Absolute difference |
| --- | ---: | ---: | ---: | ---: |
| lightweight object | 0.57 ns | 0.33 ns | 1.74x | 0.24 ns |
| fixed record | 2.45 ns | 1.42 ns | 1.72x | 1.03 ns |
| set operations | 23.52 ns | 14.47 ns | 1.63x | 9.05 ns |
| callback payload | 23.27 ns | 19.04 ns | 1.22x | 4.23 ns |
| three-parser aggregate | 234.89 ns | 208.77 ns | 1.13x | 26.12 ns |
| `Number(string)` | 87.24 ns | 77.78 ns | 1.12x | 9.46 ns |
| string padding | 260.34 ns | 238.99 ns | 1.09x | 21.35 ns |

The two highest ratios describe sub-3 ns loops that ART substantially scalar
replaces or eliminates. They are not currently sound optimization priorities.
The parser aggregate is fully decomposed by record 0054; its obvious
single-pass shortcut did not survive adjacent A/B/A measurement.

Direct JVM wins the current Kotlin comparison for widget construction, scalar
setters, two-string arguments, fresh string results, the aggregate string
workload, normalization, slicing, array pipelines, optional values, maps,
Math, nullable object results, captured callbacks, dynamic text updates, and
composite screen rows. It is within 6% for view-tree children, managed class
dispatch, ordinary arrays, callbacks, parser suboperations, byte arrays, and
string search.

The application-shaped results are particularly important:

| Scenario | Direct JVM | Kotlin | Direct/Kotlin |
| --- | ---: | ---: | ---: |
| widget construction | 28.33 us | 31.30 us | **0.91x** |
| view-tree child | 105.22 us | 103.48 us | 1.02x |
| dynamic text update | 216.60 ns | 277.75 ns | **0.78x** |
| composite screen row | 99.86 us | 180.63 us | **0.55x** |

`view-tree` still has only three high-variance samples. The 21-sample composite
screen remains the stronger application-shaped observation.

## Product shape

| Measurement | Native/JNI | Direct JVM | Kotlin | NativeScript |
| --- | ---: | ---: | ---: | ---: |
| process launch | 763 ms | 767 ms | 756 ms | 1,308 ms |
| warm foreground | 76 ms | 47 ms | 164 ms | 62 ms |
| total PSS | 20,560 KiB | 19,217 KiB | 19,207 KiB | 76,343 KiB |
| total RSS | 144,168 KiB | 141,868 KiB | 142,592 KiB | 202,252 KiB |
| APK size | 819,483 B | 65,744 B | 2,466,000 B | 28,640,920 B |

Launch values are `am start -W` completion, not first-visible-frame timing.
APK sizes describe the four deliberately different product shapes and are not
normalized library-size claims.

## Decision

Replace the README table with this single current run. Do not rank future work
from the historical 23-scenario ratios. The existing measured Direct JVM
surface has reached practical Kotlin parity; the next material optimization
should come from extending the language/application workload to an important
compiler-owned feature that is not represented yet, then optimizing the
measured implementation. Chasing a one-nanosecond record loop or a rejected
parser shortcut would be less valuable than increasing real program coverage.

The raw report is:

- `.native-typescript/benchmarks/android/2026-08-24T21-25-01-359Z/results.json`.
