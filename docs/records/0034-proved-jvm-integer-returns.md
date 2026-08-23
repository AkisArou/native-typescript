# 0034 — Keep proved internal Number returns in Java `int`

Status: implemented and measured  
Recorded: 2026-08-24

Managed fields and arithmetic could already remain Java `int`, but every
generated function and virtual method still returned source-level `number` as
Java `double`. The managed-class kernel therefore widened the base result,
performed the derived addition in `double`, returned another `double`, and
repeated that conversion at every virtual dispatch even though the complete
method family can only produce `1..1024`.

The preceding direct-body experiment in record 0033 showed no win because ART
can already inline a trivial wrapper. Return descriptors are different: an
`ireturn`/`()I` contract removes conversions that remain visible to ART.

## Decision

ScriptC's shared number facts now infer exact internal return summaries. A
generated JVM implementation may use Java `int` only when every reachable
return is proved finite, whole, signed-int32, and never observable `-0`.
Exact calls consume that summary transitively.

A Java virtual descriptor belongs to its override family, so it specializes
only when every concrete implementation of the oldest declared slot agrees.
One fractional, overflowing, unknown, or incomplete override keeps the whole
family on `double`. Direct `super` calls may consume the exact base summary,
but they cannot change the virtual descriptor independently.

The public TypeScript ABI does not change. An exported `number` method remains
Java `double`; only compiler-private implementation functions and complete
managed virtual families use `int`, with widening at a public boundary when
needed.

The facts retain intervals rather than only a yes/no integer bit. That matters
for ordinary derived arithmetic: knowing merely that `super.step()` is some
int32 makes `super.step() + 1` potentially overflow, while the exact
`0..1023` summary proves `1..1024`. The abstract interpreter also recognizes
`x & M` as `0..M` for a known non-negative int32 mask. This is the general
bit-subset property used by bounded hashes, table indices, and ring buffers;
it is not a benchmark exception.

## Disagreeing proof

The compiler tests contain both sides of the descriptor decision:

- an all-integer base/derived family and a transitive exact-call chain must
  specialize;
- a family with one fractional override must remain `double` at every static
  class view;
- a masked state field returned by a base method, then incremented by a
  derived `super` call, must retain its exact range and specialize the family.

Generated-source, host-JVM, D8, and Android-build observers require an `int`
managed method and `ireturn`. The Android observer specifically requires:

```text
invokevirtual ...m_...:()I
```

The unchanged managed-class bytecode now contains:

```text
private static int ...ManagedCounterBase.step(...)
  ... iand
  ireturn

private static int ...ManagedCounter.step(...)
  invokestatic ...ManagedCounterBase.step:(...)I
  ... iadd
  ireturn
```

The public benchmark entry remains `public static double runManagedClasses()`.

## On-device measurement

The candidate used the selective runner from record 0033 and the unchanged
`managed-class` contract: 100,000 virtual calls through a base-typed object,
one derived override and `super` call per iteration, a stateful masked field,
a derived field read, and a checked accumulated result. The Pixel 10 Pro
x86-64 API 37 AVD ran five cyclic process rounds after ART `speed`
compilation. Each implementation contributed 35 measured samples after its
ordinary warmups. Lower is better.

| Implementation | Previous controlled run | Integer-return run | Raw change |
| --- | ---: | ---: | ---: |
| Kotlin control | 1.20351 ns | **1.20305 ns** | -0.04% |
| direct JVM Native TypeScript | **2.03785 ns** | **1.30380 ns** | **-36.02%** |

The candidate run's complete matched result was:

| Implementation | Median per dispatch | Observed range | Ratio to Kotlin |
| --- | ---: | ---: | ---: |
| Kotlin | **1.20305 ns** | 1.17851–99.59296 ns | 1.00x |
| direct JVM Native TypeScript | **1.30380 ns** | 1.20467–25.77620 ns | **1.08x** |
| NativeScript | 1.87586 ns | 1.69672–2.61076 ns | 1.56x |
| JNI Native TypeScript | 67.03810 ns | 52.47282–400.05197 ns | 55.72x |

The direct JVM route is now within 0.101 ns of Kotlin, 30.5% faster than
NativeScript, and 51.42x faster than the native/JNI route for this declared
workload. The controls still bound interpretation: this is evidence for the
descriptor change on this workload, not a universal language ranking.

Raw evidence:

```text
/home/akisarou/.cache/nts-tmp/managed-class-selector-baseline-five-round/results.json
sha256:73eb2f6cdd5b8d0f40cc2861ec0b958929336412b0c5423454539fdb021d06d3

/home/akisarou/.cache/nts-tmp/managed-class-int-return-five-round-device/results.json
sha256:1f377585296b2d43668baa9e58f08fe749d3990be0f607973235db23b9ad6b78

/home/akisarou/.cache/nts-tmp/managed-class-int-return-five-round-device/
  native-typescript-jvm/bytecode-evidence.txt
sha256:9434b98f474292730c0e610ec808b198b4bf4f5f3200fb3d8b5b2038df9d92f9
```

## Consequence

The managed-class gap was not inherent virtual-dispatch overhead. Most of it
was a representation choice around a source-level `number` that the compiler
could prove narrower. Internal descriptor specialization is retained; method
body duplication remains rejected.

The next candidate should likewise name a bytecode-level cost that ART cannot
already erase, establish a selective baseline, and survive an unchanged
on-device workload before becoming architecture.
