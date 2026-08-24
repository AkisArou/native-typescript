# 0052 — Let JVM math operations carry their own special values

Status: implementation, strengthened semantic proof, and repeated device measurement complete  
Recorded: 2026-08-24

The fresh Android hotspot batch left static math as the largest repeatable
Direct JVM gap among the bounded language kernels: 43.10 ns per transform
against Kotlin's 29.10 ns. The generated source exposed fifteen redundant
special-value predicates in each benchmark iteration. Four `Math.trunc` calls
and one `Math.round` call each classified NaN, infinity, and zero before using
JVM operations that already preserve or propagate those values.

## Decision

`ntsMathTrunc` now selects `Math.ceil` for negative values and `Math.floor`
otherwise, without an earlier special-value branch:

```java
return value < 0.0d ? Math.ceil(value) : Math.floor(value);
```

This is JavaScript-exact for every `double`:

- `Math.ceil` and `Math.floor` propagate NaN and both infinities;
- both preserve signed zero;
- negative finite values need `ceil`, and non-negative finite values need
  `floor`.

`ntsMathRound` likewise no longer classifies special values first. Its
existing `Math.floor` arithmetic propagates NaN and infinities. `Math.floor`
preserves an input `-0`, and the final sign branch still creates `-0` for the
finite interval `[-0.5, 0)`.

The change is deliberately general rather than a benchmark-range
specialization. It removes work for all reached Direct JVM `Math.trunc` and
`Math.round` calls while preserving the full JavaScript number domain.

## Falsification

The structural observer was red first because both generated helpers still
contained `Double.isNaN`, `Double.isInfinite`, and `value == 0.0d` checks. It
now proves those classifications are absent.

The executable math fixture was strengthened at the same time. In addition to
the existing fractional and negative-zero cases, it now checks `trunc` and
`round` over NaN, positive infinity, negative infinity, and input negative
zero. Its all-bits checksum is `131071`, and the host JVM test executes that
result through generated Java and classfiles.

## Repeated on-device result

The unchanged `math-operations` workload performs 100,000 deterministic
quarter-step transforms per sample. Each report contains five cyclic process
rounds and 35 samples per application after ART `speed` compilation on the
API 37 x86-64 Pixel 10 Pro AVD. Lower is better.

| Route | Before | Optimized first run | Optimized repeat |
| --- | ---: | ---: | ---: |
| Direct JVM | 43.10 ns | **19.59 ns** | **21.57 ns** |
| Kotlin | 29.10 ns | 28.93 ns | 27.02 ns |
| Direct/Kotlin | 1.48x | **0.68x** | **0.80x** |

The Direct workload improves 54.5% and 50.0% in the two post-change
observations. Kotlin remains in its prior band, so the normalized result is
not produced by a slower comparison application. Direct JVM is 32.3% and
20.2% faster than Kotlin in the repeated measurements. Every checksum passed.

The pre-change schema-8 report is:

- `.native-typescript/benchmarks/android/2026-08-24T18-53-20-414Z/results.json`.

The post-change reports are:

- `.native-typescript/benchmarks/android/2026-08-24T19-00-08-877Z/results.json`;
- `.native-typescript/benchmarks/android/2026-08-24T19-02-30-963Z/results.json`.
