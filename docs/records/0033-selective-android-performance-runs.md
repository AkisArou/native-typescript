# 0033 — Select one Android workload before optimizing it

Status: benchmark instrument implemented; first candidate rejected  
Recorded: 2026-08-24

The Android comparison had the right matched workloads but only one execution
shape: build four APKs, run the complete hotspot matrix, and also measure
launch and memory. That is the correct release report, but it made a small
compiler hypothesis expensive to falsify and encouraged reading unrelated
kernel noise as evidence about the change under test.

## Decision

The runner accepts repeatable `--scenario NAME` selections. Names resolve
against the authoritative scenario catalog, so selection cannot change a
workload's inputs, iteration count, warmups, samples, expected checksum, or
comparison implementations. Unknown names and duplicates are errors.

A selected run:

- builds and installs the same participating APKs;
- asks ART for the same `speed` compilation;
- rotates implementation order by round as before;
- executes only the selected workload contracts;
- records only those contracts in schema version 7 of `results.json`;
- measures launch and memory only when `view-tree` is selected.

Omitting `--scenario` preserves the complete matrix. This is an experiment
filter, not a second benchmark definition.

## First falsification

The next candidate from record 0032 was the thin Java instance method that
forwards a virtual call to ScriptC's static lowered semantic body. A candidate
emitter put the lowered body directly in each instance method while retaining
the static copy for exact `super` and direct calls. Compiler, host-JVM, and D8
checks passed.

Two five-round `managed-class` runs used the new selector on the Pixel 10 Pro
x86-64 API 37 AVD. Each implementation contributed 35 measured samples after
its ordinary warmups. Lower is better.

| Implementation | Existing wrapper | Direct body candidate | Raw change |
| --- | ---: | ---: | ---: |
| Kotlin control | 1.20351 ns | 1.20420 ns | +0.06% |
| NativeScript control | 1.72933 ns | 1.84763 ns | +6.84% |
| direct JVM Native TypeScript | **2.03785 ns** | **2.16343 ns** | **+6.16%** |
| JNI Native TypeScript | 57.21839 ns | 61.41348 ns | +7.33% |

The controls show ordinary run-to-run movement, so this is not a claim that
direct bodies intrinsically regress ART. It is stronger and sufficient
evidence that removing the wrapper did **not** demonstrate a win. ART already
has the opportunity to inline the trivial forwarder, while duplicating the
body may change code layout. The candidate compiler change was removed; the
single lowered semantic body and thin instance wrapper remain.

Raw evidence:

```text
/home/akisarou/.cache/nts-tmp/managed-class-selector-baseline-five-round/results.json
sha256:73eb2f6cdd5b8d0f40cc2861ec0b958929336412b0c5423454539fdb021d06d3

/home/akisarou/.cache/nts-tmp/managed-class-direct-body-five-round/results.json
sha256:902b5045a305826cdaa41b5e47925e8d301af208942d32b3855743b3ee86fa62
```

## Consequence

Optimization work can now start with a controlled baseline and candidate run
for one declared hotspot, then pay for the complete matrix only after a result
survives. The first use also answered the method-wrapper question without
shipping speculative compiler complexity. Integer return specialization is
still a distinct candidate: unlike a forwarding method that ART can already
inline, changing a proved internal descriptor from `double` to `int` can
remove real conversions visible in bytecode. It still needs its own observer
and on-device before/after measurement.

