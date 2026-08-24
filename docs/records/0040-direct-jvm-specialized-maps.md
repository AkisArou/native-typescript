# 0040 — Specialize Direct JVM maps without boxing

Status: implementation and host proof complete; device measurement pending  
Recorded: 2026-08-24

Native IR already fixes every reached `Map<K, V>` key and value type. Mapping
that contract to `HashMap<K, V>` would erase primitive values into generic
objects, allocate `Double`/`Boolean` wrappers, and delegate JavaScript's live
insertion-order iteration semantics to a Java collection with a different
mutation contract.

## Decision

The Direct JVM emitter generates one exact class per reached map
specialization. It stores insertion-ordered entries in parallel arrays:

```text
String[] or double[] keys
double[] / boolean[] / ExactReference[] values
boolean[] live
int[] table
```

The `int[]` open-addressed table contains dense-entry indices, so lookup is
expected O(1) without a generic payload. String keys use content hashing and
equality. Number keys normalize signed zero and canonicalize NaN, preserving
JavaScript `SameValueZero` rather than Java `Double.equals` behavior.

Deletion tombstones the dense entry and its hash slot. Reinsertion appends a
new dense entry, retaining JavaScript insertion order. `forEach` and the other
frontend-desugared iteration forms bracket a live-iteration depth: deletes are
skipped, appended entries are visited, and `clear()` keeps the old dense range
while an iterator is active so later appends remain visible. Dense compaction
is allowed only after the outermost iterator exits.

`get()` returns the compiler's exact `V | undefined` representation. Reference
optionals remain nullable ART references; scalar optionals use their generated
typed union. General union values are translated arm-for-arm when adding the
missing `undefined` arm, without an `Object` payload.

Seeded construction uses one typed factory per source expression. Java
evaluates its key/value arguments left-to-right, after which the factory calls
`set()` in source order. Repeated keys therefore overwrite in place without
reordering, while source side effects remain observable in the right order.

## Matched workload

Android benchmark contract version 9 adds `map-operations` to Native
TypeScript/JNI, Direct JVM, Kotlin, and plain NativeScript. Each sample runs
50,000 updates over sixteen fixed string keys, exercising:

- `get()` with a number-or-undefined result;
- insert and overwrite through `set()`;
- `has()`, `delete()`, and reinsertion;
- `size` consumption on every update;
- bounded keys so dynamic string construction does not hide map cost.

Kotlin uses a typed `LinkedHashMap<String, Int>` to retain the same ordered-map
shape. The independently computed checksum is 83,989,039.

## Evidence at this checkpoint

The initial observer failed precisely at `mapNew`. After lowering:

- seeded maps, overwrite, `get`, `has`, `delete`, `size`, and `clear` execute
  correctly through javac and the host JVM;
- NaN keys compare equal and positive/negative zero name one entry;
- live callback mutation skips a deleted entry and visits a later append;
- active-iteration `clear()` still visits entries appended by the callback;
- a 96-entry rehash/delete/compact/reinsert stress case preserves every value;
- classfile inspection finds exact key/value arrays and no `Object`,
  `HashMap`, `LinkedHashMap`, scalar wrapper, or JNI path;
- all four Android applications declare the same workload, iteration count,
  and checksum, and the runner records the nested map class in its bytecode
  evidence.

No APK, emulator, or device timing was run for this slice. A later explicitly
opened benchmark window will measure the unchanged four-application workload.
