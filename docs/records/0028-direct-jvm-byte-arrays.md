# 0028 — Keep JVM byte arrays in ART

Status: experimental direct-JVM slice implemented and measured  
Recorded: 2026-08-23

[Record 0027](0027-direct-jvm-reference-values.md) left primitive arrays and
same-thread callbacks as the two strongest measured direct-JVM candidates.
The existing 256-byte Base64 workload isolated the former: JNI Native
TypeScript copied the input into a Java array, copied the Java result back
into `ScrBytes`, and then read its length. Kotlin passed one `byte[]` and
consumed the returned `byte[]` directly.

## Decision

The direct JVM backend represents ScriptC `bytes<u8>` as Java `byte[]` for
the exact surface this workload reaches:

- a function parameter or local has Java type `byte[]`;
- a direct binding argument is admitted only against descriptor `[B`;
- a direct binding result is admitted only from descriptor `[B`;
- `length` and `byteLength` emit JVM `arraylength`;
- a Native IR frame-bounded result needs no JNI cleanup in this backend,
  because the array remains an ordinary ART-managed reference.

This is not a blanket typed-array implementation. Java `byte` is signed while
`Uint8Array` element reads widen to 0–255, so element reads, writes,
construction, slices, and every other bytes intrinsic remain refused until
their semantics are lowered explicitly. Other element families remain
refused too. Exact descriptor and element-kind checks prevent a different
Java array from entering through the new representation.

The shared number analysis now treats bytes length observations as pure,
whole, non-negative safe integers. This preserves immutable-global and loop
induction facts around `arraylength` without claiming that an externally
supplied array length or an accumulated checksum fits signed int32.

## Disagreeing proof

The executable JVM observer first failed with:

```text
JVM backend does not support type 'bytes'
```

It now sends a real `byte[]` through the fixture's reversing Java method,
reads the returned length, and executes the result. The Android observer uses
the pre-existing workload unchanged:

```ts
while (index < BYTE_ARRAY_ITERATIONS) {
  checksum += Base64.encode(input, 2).length;
  index += 1;
}
```

The Java harness constructs and fills the same 256-byte input as Kotlin before
timing. The runner compares its length constant with the other implementations
at build time.

Accepted `javap` evidence for the timed body is structurally:

```text
aload input
iconst_2
invokestatic android/util/Base64.encode:([BI)[B
arraylength
i2d
dadd
```

The loop induction is Java `int`. The checksum remains `double`: the exported
function accepts any Java array, and 2,000 accumulated result lengths are not
provably signed-int32 for every valid caller. There is no `nts_jvm_` entry,
managed bytes helper, JNI array operation, or invocation of `ntsToInt32` or
`ntsToBool` in the kernel.

## On-device measurement

All four APKs ran for five cyclically ordered process rounds on the Pixel 10
Pro x86-64 API 37 AVD after ART `speed` compilation. Every row has 35 accepted
samples with identical input bytes, warmups, iteration counts, and checksums.
Lower is better.

| Implementation | Median per 256-byte encoding | Ratio to Kotlin |
| --- | ---: | ---: |
| direct JVM Native TypeScript | **756.13 ns** | **0.94x** |
| Kotlin | 800.25 ns | 1.00x |
| JNI Native TypeScript | 1,620.23 ns | 2.02x |
| NativeScript | 8,827.93 ns | 11.03x |

The direct path is 2.14x faster than the JNI route and 11.68x faster than
NativeScript in this matched run. Its 0.94x Kotlin ratio is whole-kernel ART
variance, not a claim that TypeScript makes `Base64.encode` intrinsically
faster. The structural claim is the bytecode: both direct JVM and Kotlin now
pay for the platform operation and returned Java allocation, not a second
language representation or boundary copy.

Raw evidence:

```text
/home/akisarou/.cache/nts-tmp/android-direct-byte-array-five-round/results.json
sha256:f35a43c3d84beea2ddb734faa3bfaaca9a9cbc7d5c4ee6731548e8e2bcffc982

/home/akisarou/.cache/nts-tmp/android-direct-byte-array-five-round/
  native-typescript-jvm/bytecode-evidence.txt
sha256:317fbeca0f9c235c397129eaac41253553e16538df190a8c31009365cbadcb4c
```

The six-kernel direct-JVM APK is 16,592 bytes. It is still not a complete
application backend, so launch and memory comparisons remain limited to the
three full applications.

## Consequence

Java primitive arrays are another exact resident representation when the
program itself executes on ART. A direct `ByteBuffer` path is still a distinct
API-family optimization for native-backed shared memory; it is not needed to
avoid copies when both the caller and callee already use the same Java array.

The largest remaining measured boundary is now same-thread callbacks. Moving
that workload into the direct tier requires closures plus generated interface
or listener adapters, and must keep the same unchanged-source, bytecode, and
device admission rule.
