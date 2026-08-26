# 0060 — Preserve static string identity across the Blink boundary

Status: implementation and browser correctness build complete; measurement pending  
Recorded: 2026-08-25

The application matrix in record 0058 repeatedly converts ScriptC's immortal
UTF-8 literals into Blink `String` or `AtomicString` values. The generated
ScriptC literal itself allocates nothing, but every `createElement`, attribute,
selector, event-name, or literal-text call previously repeated UTF-8 decoding
and, for atomic strings, atom-table lookup. Component-shaped workloads repeat
the same small tag and property strings enough for that boundary work to become
structural rather than incidental.

## Contract

SCABI schema 14 adds an optional `staticIdentity` sibling to a length-delimited
UTF-8 input. The physical slot is an unsigned pointer-width integer. It is not
the string value and native code must never dereference it:

- a direct compiler-owned immortal string literal supplies its stable address;
- a computed, parameter, captured, or otherwise unproved string supplies zero;
- equal non-zero identities within one loaded program instance guarantee equal
  bytes;
- unequal identities make no claim about content, so data and length remain the
  complete semantic value.

This keeps the optimization declarative and target-independent. It neither
exposes the `ScrStr` layout nor asks a Chromium capsule to recognize ScriptC
heap addresses. A future const-propagation proof can widen the non-zero cases
without changing the ABI.

Both the C and LLVM emitters consume the same Native IR
`utf8StaticIdentity` projection. C emits the literal object address as an
opaque `size_t`; LLVM emits `ptrtoint` at the target pointer width. Both emit
zero for an expression whose storage lifetime is not proven. Unit tests cover
the literal and computed-string paths in both backends.

## Blink cache

Each `NtsWebRealm` owns separate maps for decoded `String` and
`AtomicString` values. A zero identity bypasses the maps and preserves the
ordinary dynamic conversion. A non-zero identity performs an O(1) lookup and
decodes only on the first use in that realm. Realm invalidation clears both
maps before releasing the document, so navigation cannot retain application
text or reuse an identity in a new execution context.

The cache is not a semantic interner. ScriptC still owns TypeScript strings;
Blink still owns the values passed to WebIDL implementations; the opaque token
only prevents repeating a proven-pure representation conversion.

## Evidence

- SCABI, translation, and Chromium generator tests pass (67/67 focused tests).
- Native IR validates and emits the literal/non-literal distinction for C and
  LLVM.
- Both localized benchmark and counter archives compile with the new ABI.
- Generated C contains non-zero literal identities and zero computed-string
  identities; generated LLVM contains the matching `ptrtoint` and zero forms.
- The pinned official ThinLTO/CFI `content_shell` compiles and links with the
  refreshed bridge.

No performance number is recorded yet. The next benchmark must use the same
four-lane application matrix and quiet-machine protocol as record 0058; until
then this record claims removal of repeated work, not a measured speedup.

## Decision

Keep static identity as an optional general SCABI optimization hint. Do not
cache arbitrary dynamic strings without an explicit bound, do not retain
borrowed UTF-8 pointers, and do not couple generated Blink code to ScriptC's
private string representation.
