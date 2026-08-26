# 0064 — Preserve static string identities through runtime choices

Status: implemented, release browser rebuilt, controlled matrix recorded  
Recorded: 2026-08-26

Record 0060 introduced an opaque process-lifetime identity for a direct string
literal. Blink uses that identity as a realm-local cache key for decoded
`String` and `AtomicString` values. Record 0063 showed the design working at
application scale, but retained text and selector mutation still missed the V8
gate.

Inspection of the generated benchmark artifacts found a narrower compiler
problem. Both kernels choose between two string literals with a ternary. The
selected `ScrStr*` remains one of two compiler-owned immortal objects, but the
native-call planner emitted a zero `utf8StaticIdentity` because the immediate
source expression was not itself a `strLit`. Blink consequently decoded and,
for the selector attribute, atomized the chosen bytes on every iteration.

## Compiler correction

Both C and LLVM emission now ask the existing
`expressionResultIsImmortal` proof whether every possible result is an
immortal string. A direct literal and a finite conditional tree composed only
of literals therefore pass the selected string object's nonzero address as the
opaque identity. A computed string, including concatenation, still passes zero
and uses the dynamic conversion path.

This does not expose or dereference ScriptC's string layout. The identity is a
process-lifetime cache token only, scoped by the Blink realm, and navigation
still clears every cached Blink value. Compiler tests cover direct literals,
conditional literal choices, and dynamic fallback in both backends. Chromium's
performance-artifact gate additionally refuses a zero identity at the retained
text setter and selector attribute call sites.

## Focused attribution

The official non-component release `content_shell` was incrementally rebuilt
at the pinned Chromium revision. Each focused run used fresh renderers, CPU 0,
rotated lane order, three repetitions, and 30 checked samples per repetition.
Lower is better.

| Retained text shape | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Compiled loop | 115.88 ns | 79.72 ns | 79.23 ns | 82.00 ns | **0.688x** | **0.684x** | **0.972x** | **0.966x** |
| Per call | 118.88 ns | 93.30 ns | 92.20 ns | 90.00 ns | **0.785x** | **0.776x** | 1.037x | 1.024x |

| Selector shape | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Compiled loop | 130.10 ns | 128.30 ns | 127.60 ns | 120.00 ns | **0.986x** | **0.981x** | 1.069x | 1.063x |
| Per call | 565.70 ns | 599.30 ns | 601.30 ns | 740.00 ns | 1.059x | 1.063x | **0.810x** | **0.813x** |

Both focused reports pass every applicable gate. The retained compiled loop is
31.2–31.6% faster than handwritten C++ and effectively matches V8; the former
1.58–1.59x-V8 regression is gone. Selector mutation is within 1.9% of C++ in
the compiled shape and 18.7–19.0% faster than V8 per call.

## Final application matrix

The complete seven-family, two-shape matrix was then rerun with the same
three-repetition, 90-sample-per-cell policy. All 84 fresh renderer runs passed
their checked result, blank-DOM/listener teardown, and ScriptC subscription
checks.

| Workload / shape | C++ | ScriptC C | ScriptC LLVM | V8 | C/C++ | LLVM/C++ | C/V8 | LLVM/V8 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Attached component mount / compiled | 1,360.0 ns | 1,398.0 ns | 1,409.5 ns | 1,800.0 ns | 1.028x | 1.036x | **0.777x** | **0.783x** |
| Attached component mount / per call | 1,431.5 ns | 1,476.5 ns | 1,521.5 ns | 1,900.0 ns | 1.031x | 1.063x | **0.777x** | **0.801x** |
| Create element / compiled | 44.11 ns | 42.70 ns | 50.42 ns | 94.50 ns | **0.968x** | 1.143x | **0.452x** | **0.534x** |
| Create element / per call | 53.62 ns | 63.28 ns | 63.11 ns | 96.50 ns | 1.180x | 1.177x | **0.656x** | **0.654x** |
| Detached counter tree / compiled | 395.63 ns | 334.10 ns | 334.96 ns | 378.50 ns | **0.844x** | **0.847x** | **0.883x** | **0.885x** |
| Detached counter tree / per call | 323.03 ns | 258.70 ns | 262.27 ns | 399.00 ns | **0.801x** | **0.812x** | **0.648x** | **0.657x** |
| Eight-row component list / compiled | 5,105.5 ns | 5,380.0 ns | 5,374.5 ns | 7,350.0 ns | 1.054x | 1.053x | **0.732x** | **0.731x** |
| Eight-row component list / per call | 6,221.5 ns | 6,841.0 ns | 6,068.0 ns | 7,550.0 ns | 1.100x | **0.975x** | **0.906x** | **0.804x** |
| Retained attached-text update / compiled | 115.95 ns | 79.25 ns | 79.17 ns | 81.00 ns | **0.683x** | **0.683x** | **0.978x** | **0.977x** |
| Retained attached-text update / per call | 119.18 ns | 91.99 ns | 93.02 ns | 89.00 ns | **0.772x** | **0.780x** | 1.034x | 1.045x |
| Selector-driven update / compiled | 130.00 ns | 130.10 ns | 127.60 ns | 120.00 ns | 1.001x | **0.982x** | 1.084x | 1.063x |
| Selector-driven update / per call | 555.40 ns | 606.80 ns | 601.70 ns | 740.00 ns | 1.093x | 1.083x | **0.820x** | **0.813x** |
| Synchronous event round trip / compiled | 905.20 ns | 963.25 ns | 1,006.6 ns | 885.00 ns | 1.064x | 1.112x | 1.088x | 1.137x |
| Synchronous event round trip / per call | 953.00 ns | 1,091.5 ns | 1,065.0 ns | 1,600.0 ns | 1.145x | 1.118x | **0.682x** | **0.666x** |

The strict evaluator reports three performance violations, down from 22 in
record 0058 and eight in record 0063. Two are reproducible create-element
per-call p95 ratios: 1.299x C++ for C and 1.313x for LLVM against the 1.25x
tail gate. Their medians pass and remain 34.4–34.6% faster than V8. The third is
the compiled LLVM event median at 1.137x V8 against the 1.10x gate.

A focused event confirmation using the exact same browser and native archives
passes every applicable gate. Its compiled C/LLVM medians are 1.068x/1.046x V8
and its per-call medians are 0.697x/0.767x V8. The full-matrix event violation
is therefore recorded as measurement variance, not hidden or used to weaken
the threshold. The two create-element tail checks remain the next reproducible
performance target.

Median renderer peak RSS in the final matrix is:

| Workload | C++ | ScriptC C | ScriptC LLVM | V8 |
| --- | ---: | ---: | ---: | ---: |
| Attached component mount | 157.3 MiB | 153.6 MiB | 153.4 MiB | 173.0 MiB |
| Create element | 189.8 MiB | 190.3 MiB | 189.6 MiB | 202.9 MiB |
| Detached counter tree | 1,157.9 MiB | 1,037.8 MiB | 1,038.3 MiB | 218.2 MiB |
| Eight-row component list | 276.3 MiB | 259.3 MiB | 259.0 MiB | 200.8 MiB |
| Retained attached-text update | 118.5 MiB | 118.4 MiB | 118.2 MiB | 132.8 MiB |
| Selector-driven update | 156.2 MiB | 156.6 MiB | 156.6 MiB | 172.1 MiB |
| Synchronous event round trip | 365.9 MiB | 366.1 MiB | 365.2 MiB | 180.4 MiB |

## Evidence and decision

The final matrix records Native TypeScript
`9f30b0d7a3dc530761b30aae9096bcb07a10722b`, ScriptC
`330076cd1c6c158d0ab33a8d0991924b92733533`, Chromium
`96324a4012fe62f48b9463a67486eeb645bc5c78`, and exact binary, archive,
fixture, compiler, GN, workload-budget, affinity, and lane-scheduling
provenance.

- retained focused raw: `.native-typescript/benchmarks/chromium/2026-08-26-conditional-static-identity-retained-text/raw.json` (`sha256:fd97497faa5a6c37834bd3b817c56a47be8e0b2f61700dc39ee822298254c5b6`);
- retained focused report: `.native-typescript/benchmarks/chromium/2026-08-26-conditional-static-identity-retained-text/report.json` (`sha256:75e24ba7d8753240f9582f37b1b2a29ed7d17bb9fb3e3ef434d5bd6fb2d71186`);
- selector focused raw: `.native-typescript/benchmarks/chromium/2026-08-26-conditional-static-identity-selector/raw.json` (`sha256:34aa282fcb9a5425365333d01157ab8765674bb711bce062e772a0ded0373248`);
- selector focused report: `.native-typescript/benchmarks/chromium/2026-08-26-conditional-static-identity-selector/report.json` (`sha256:11d966da81975752ace291dae87696091f3cf8be251b3a78a8de500a0d1f4d31`);
- full matrix raw: `.native-typescript/benchmarks/chromium/2026-08-26-application-matrix-after-conditional-identities/raw.json` (`sha256:612241e6db993aa29e6a8e6f71a9ab1f85d18b007d4b95240922ad607187b258`);
- full matrix report: `.native-typescript/benchmarks/chromium/2026-08-26-application-matrix-after-conditional-identities/report.json` (`sha256:ffc03bb898d7a5b879fd9a11a29e6d02b75bc9bae7349bfc334c5a774900ec3b`);
- focused event raw: `.native-typescript/benchmarks/chromium/2026-08-26-conditional-static-identity-event-confirmation/raw.json` (`sha256:5d0aa09eff613cd2c99c65fe1164766a04970506c4f955b2f8da74cdd383483b`);
- focused event report: `.native-typescript/benchmarks/chromium/2026-08-26-conditional-static-identity-event-confirmation/report.json` (`sha256:21469ac38f9380445e8b335f3add8c8345151b0464989159f1cac66dfb7ca06f`).

Keep the direct-Blink architecture and the strict gates. Conditional static
identity is a safe compiler generalization with a measured application effect,
not a benchmark-only special case. Profile the tiny per-call create-element
tail next; keep product Content-host work, broader WebIDL generation, native
async resolvers, and complete event semantics as the architectural milestones.
