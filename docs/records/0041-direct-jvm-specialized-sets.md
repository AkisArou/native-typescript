# 0041 — Specialize Direct JVM sets without boxing

Status: implementation and host proof complete; device measurement pending  
Recorded: 2026-08-24

Native IR fixes the element type of every reached `Set<T>`. Using Java's
generic `HashSet` or `LinkedHashSet` would box numeric elements and would not,
by itself, prove JavaScript's live insertion-order iteration behavior under
deletion, reinsertion, append, and `clear()`.

## Decision

The Direct JVM emitter generates one exact set class per reached element type.
It stores entries in an insertion-ordered primitive or exact-reference array,
marks live entries in a `boolean[]`, and indexes them through an open-addressed
`int[]` table. Number sets normalize signed zero and canonicalize NaN, so
membership uses JavaScript `SameValueZero` without `Double` wrappers.

Deletion tombstones an entry. Reinsertion appends it at the end. Iteration
skips deleted entries and visits later appends; an active iterator prevents
dense compaction, including across `clear()`, until the outermost traversal
ends. The compiler can then compact or rehash without changing observable
order.

Seeded and spread construction evaluate inputs once and in source order.
Array spread factories copy exact arrays without an `Object[]`, and
`Array.push(...array)` snapshots its source length so self-spread has the same
result as JavaScript.

## Matched workload

Android benchmark contract version 10 adds `set-operations` to Native
TypeScript/JNI, Direct JVM, Kotlin, and plain NativeScript. Each sample performs
50,000 bounded string membership updates with `add`, `has`, `delete`,
reinsertion, `size`, and periodic insertion-order traversal. Kotlin uses a
typed `LinkedHashSet<String>`. The independently computed checksum is 825,665.

The Direct-JVM runner allowlist was found to omit this already implemented
scenario. Contract version 11 corrects that omission before the first device
measurement, so future reports must include all four applications rather than
silently comparing only three.

## Evidence at this checkpoint

The observer first failed precisely at the unsupported Set construction. After
lowering:

- string and number sets preserve membership, size, deletion, and reinsertion;
- seeded construction and spread retain evaluation order;
- NaN and both signed zeros obey `SameValueZero`;
- live mutation and active-iteration `clear()` match JavaScript;
- combination methods and `toArray()` retain exact element storage;
- a rehash/delete/compact/reinsert stress case retains every member;
- javac/JVM execution agrees with the expected outputs;
- classfile inspection finds exact arrays and no `Object`, `HashSet`,
  `LinkedHashSet`, numeric wrapper, or JNI path.

No APK, emulator, or device timing was run for this slice.

