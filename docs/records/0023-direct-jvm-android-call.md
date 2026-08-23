# 0023 — Execute the first Android call directly on ART

Status: experimental slice implemented and measured; JNI remains the shipped backend  
Recorded: 2026-08-23

[Record 0022](0022-direct-jvm-backend-first-slice.md) proved that checked
TypeScript could become DEX without JNI, but it deliberately stopped at a
host-visible `println`. This slice tests the actual architectural hypothesis:
an Android API-heavy TypeScript region can stay on ART's side of the boundary
and avoid native string conversion, JNI dispatch, and native ownership work.

## Decision

The JVM binding generator now emits a deterministic target sidecar beside its
SCABI package. Each entry joins the same full binding identity used by Native
IR to the authoritative classfile coordinates that produced its JNI adapter:

```text
binding id
owner binary name
method or constructor name
JVM descriptor
native adapter entry symbol
```

SCABI remains the backend-neutral foreign contract. The sidecar does not
replace it; it supplies target facts SCABI intentionally cannot describe. A
direct emitter must not recover class and descriptor identity by parsing a C
symbol or a projected declaration name.

The ScriptC JVM emitter consumes checked serialized IR plus that sidecar. The
first Android tier supports the loop, conditional, bitwise, truthiness, and
static-call forms used by `string-argument`, and emits a public wrapper for the
platform timing harness. It verifies that Native IR and the sidecar agree on
the adapter entry symbol and precisely refuses unsupported constructors,
instance methods, resource modes, values, and descriptors.

The product path is:

```text
TypeScript -> checked ScriptC IR -> generated Java -> javac classfile
                                              -> D8 -> classes.dex -> APK
```

Generated Java is the translation unit, not the runtime. ART executes ordinary
DEX bytecode. A custom classfile emitter would produce the same runtime
instruction family and is not justified until generated-source scale or javac
latency becomes measured build friction.

## Disagreeing proof

The accepted artifact's `javap` evidence contains:

```text
invokestatic android/text/TextUtils.equals:
  (Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Z
```

It contains no native method, JNI adapter call, or `nts_jvm_*` invocation. The
binding selected by the checked TypeScript import is exactly:

```text
native-typescript.jvm.android_benchmark@0.0.0#
  android_benchmark.android.text.textutils.equals
```

The checksum is 20,000 for every accepted sample.

The first timing shape was rejected. Equal TypeScript literals became one
interned Java object, so `TextUtils.equals` could return on `a == b` without
comparing contents. That invalid shape measured 29.17 ns/comparison and even
appeared faster than Kotlin. The fixed harness constructs four
distinct-but-equal values with the same four `StringBuilder(...).toString()`
expressions as the Kotlin control, then passes them into the generated
TypeScript loop. Its disassembly proves both the four constructions and the
four-`String` generated-kernel invocation. The false result is retained here
because it demonstrates why bytecode evidence is part of the instrument.

While inspecting that artifact, numeric truthiness was also found to duplicate
its operand in generated Java. That was semantically wrong for an effectful
operand and added work. The emitter now evaluates the operand once and calls a
small JavaScript-number truthiness helper; the accepted measurement includes
that correction.

## On-device measurement

The four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Each implementation
contributed 35 accepted samples to `string-argument`. Lower is better.

| Implementation | Median | Range | Relative to Kotlin |
| --- | ---: | ---: | ---: |
| Kotlin | 36.00 ns/comparison | 30.45–232.42 ns | 1.00x |
| Native TypeScript, direct JVM | **67.44 ns/comparison** | 60.00–354.34 ns | **1.87x** |
| Native TypeScript, C/LLVM + JNI | 462.10 ns/comparison | 354.08–1,509.88 ns | 12.84x |
| NativeScript | 1,329.84 ns/comparison | 1,217.69–2,048.52 ns | 36.94x |

For this operation, direct JVM execution is 6.85x faster than the current JNI
route, an 85.4% reduction, and 19.7x faster than NativeScript. The remaining
1.87x Kotlin gap includes the direct tier's exact JavaScript `number` and
bitwise/truthiness semantics; this run does not isolate their individual cost.

Artifact observations from the same run are:

| Implementation | APK bytes | SHA-256 |
| --- | ---: | --- |
| Native TypeScript, C/LLVM + JNI | 602,395 | `8311188f6672a8a975c6c173e1a7db20098a72bd9ee5ae22e9cf6c3a8f260862` |
| Native TypeScript, direct JVM slice | 12,496 | `71ad4f1108ba835a553c22d7c6f42cc04edbb4bdbe0bbf708c2879b13af10546` |
| Kotlin | 20,688 | `10e8ad9a52c0513156dab7011689cdb5b26b9772ec4e7b711ae746834ddfe9f4` |
| NativeScript | 28,639,576 | `e22cf9c886327abca16109c740eddc1579eae4a6de4fcf6858f855bf35b4e868` |

The direct artifact is a one-kernel harness, so its size is not comparable to
the three complete applications. It participates in neither launch nor memory
summaries for the same reason.

Raw report and bytecode evidence:

```text
/home/akisarou/.cache/nts-benchmark-direct-jvm-valid/results.json
sha256:aa3637b679e28de4328e92f683f50a02930e8cabdf7f77d58c955fd5da0f3b96

/home/akisarou/.cache/nts-benchmark-direct-jvm-valid/
  native-typescript-jvm/bytecode-evidence.txt
sha256:5ea11472dc0409758f76d8505c0c0ef42dba2402f56d8e3e34b88f765ea362e1
```

## Consequence

Keep the direct JVM backend experiment. The result establishes that removing
the boundary can erase most of the measured outbound-string gap; another JNI
mechanics optimization cannot remove the boundary itself.

It does not establish that all TypeScript should compile to DEX or that the
native backend should be removed. Native libraries, native computation, and
non-JVM targets still need C/LLVM. Nor does one static call establish classes,
fields, callbacks, exceptions, async ordering, lifecycle, launch, memory, or a
complete application product.

The next measurement-bearing slice should add constructor and instance-member
calls over direct object references, then move one existing Android workload
(`light-object` or `setter`) unchanged into the fourth APK. That work should
continue consuming the binding sidecar and checked IR, keep every unsupported
shape as a precise refusal, and retain bytecode plus device evidence. Classes,
callback adapters, generated platform subclasses, and the small
Looper-integrated microtask scheduler follow only as their first executable
programs require them.
