# 0021 — Keep ordinary JVM string conversion off the native heap

Status: implemented and measured; timings remain observations, not test gates  
Recorded: 2026-08-23

[Record 0020](0020-frame-bounded-callback-payloads.md) left string arguments
as the clearest isolated gap against Kotlin. The adapter's exact UTF bridge
made every crossing correct, but its mechanics treated temporary UTF-16
storage as a heap resource even when the string was a short UI label:

```text
TypeScript -> Java: strlen -> malloc UTF-16 -> decode -> NewString -> free
Java -> TypeScript: malloc UTF-16 -> GetStringRegion -> malloc UTF-8 -> encode
```

Those allocations were target mechanics, not a language or ownership
requirement. This slice changes no SCABI or ScriptC representation.

## Decision

The generated JVM adapter now stages up to 256 UTF-16 code units in its native
frame. A larger UTF-8 input retains one exact heap fallback, and both success
and malformed-input paths free that fallback only when it exists. `NewString`
still creates the required ART object; this change does not claim a Java
string can share native storage.

The reverse bridge asks JNI for a borrowed UTF-16 view with `GetStringChars`,
encodes directly into the final owned UTF-8 allocation, and releases the view.
It no longer allocates a second native UTF-16 buffer or copies into it with
`GetStringRegion`. A failed JNI acquisition follows the existing pending-
exception channel, and a null result without an exception gets its own named
failure.

The adapter-source schema advances from 23 to 24 because the deterministic
generated mechanics and source digest changed.

## Disagreeing proof

The generated-source observer pins both resource shapes:

| Crossing | Short path | Large path | Removed operation |
| --- | --- | --- | --- |
| UTF-8 argument -> Java | 256-unit frame array | one UTF-16 heap fallback | unconditional `malloc`/`free` |
| Java result -> UTF-8 | borrowed JNI characters plus final owner | same | native UTF-16 allocation and `GetStringRegion` copy |

The live desktop JVM observer crosses a non-BMP emoji through the inline path,
crosses a 319-byte value through the heap fallback, and checks the returned
UTF-8 bytes and lengths. The existing U+0000, nullable, String-array, malformed
UTF-8, and unpaired-surrogate contracts continue to use the same bridge.

The packaged Android adapter was inspected independently: it contains the
256-unit frame array and `GetStringChars`/`ReleaseStringChars`, and contains no
`GetStringRegion` call.

## On-device measurement

The unchanged Native TypeScript, Kotlin, and plain-NativeScript suite ran for
five cyclically ordered process rounds on the same Pixel 10 Pro x86-64 API 37
AVD after ART `speed` compilation. Every repeated scenario contributed 35
accepted samples. The comparison is against the immediately preceding
frame-bounded-callback run in [record 0020](0020-frame-bounded-callback-payloads.md):

| Workload | Before | Frame-local bridge | Raw change | NTS/Kotlin before -> after |
| --- | ---: | ---: | ---: | ---: |
| two ASCII/Unicode string arguments | 662.17 ns | 425.27 ns | **-35.8%** | 16.83x -> 14.14x |
| fresh Java string result | 674.25 ns | 493.48 ns | **-26.8%** | 2.71x -> 2.43x |
| dynamic text update | 547.37 ns | 424.23 ns | -22.5% | 1.93x -> 1.98x |
| composite screen row | 129.45 us | 83.68 us | -35.4% | 1.17x -> 0.94x |

The controls were materially faster in this emulator run too. Kotlin's string
argument improved 23.5% and NativeScript's improved 23.9%; Native TypeScript's
Kotlin-normalized ratio nevertheless improved 16.0%, and its NativeScript-
normalized ratio improved 15.6%. For string results, Kotlin improved 18.1%
and NativeScript improved 30.4%; the NTS/Kotlin ratio improved 10.6% while the
NTS/NativeScript ratio worsened 5.1%.

Dynamic text updates moved almost exactly with both controls, so their raw
22.5% change is not attributed to this implementation. The composite workload
is higher variance and is recorded, not claimed as a 35.4% bridge win. The
isolated normalized cases plus the exact removed allocation admit the change.

Raw report and checksum:

```text
/home/akisarou/.cache/nts-tmp/android-string-bridge-five-round-avd/results.json
sha256:37182a0cac3804d738c661cea28b9fdddaee33ee8ace77fc3a040a17d44b5db4
```

## Consequence

Keep this target-owned mechanics improvement. It did not need a new foreign
string representation, and the measurement shows that such an architecture
should not be introduced merely to remove staging allocations that the
adapter can avoid itself.

String arguments still create a fresh ART `String` for each crossing; the
isolated case remains 14.14x Kotlin. The next string-specific hypothesis is
compiler-visible residency for literals or other proven invariant immutable
strings. It needs a bounded lifetime and a disagreeing dynamic-string arm—an
unbounded adapter content cache or native-pointer identity is not acceptable.
Generated token dispatch remains the independent callback/DX candidate.
