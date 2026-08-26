# 0059 — Symbols and dispatch in the checked-dynamic tree

Status: implemented in the fork; parent gate green  
Recorded: 2026-08-25

[Record 0058](0058-react-core-compiles-and-what-stops-the-rest.md) measured
pinned React and named three compiler items behind 11 of its 18 remaining
fences. Two of them are now built, and a third turned out to belong on the
source side. React core is at **8 fences**, down from 18, and 96% of its
reachable statements now lower statically.

## What was wrong

The checked-dynamic value tree carried undefined, null, booleans, numbers,
strings, bytes, objects, arrays, functions, handles and promises — and no
symbol. SC1101 is, by its own registry entry, "converting typed values to
'unknown'", so a symbol could not enter an untyped array or object. That is
where every branded value in real JavaScript ends up, which made the gap much
larger than its diagnostic suggested.

`switch` separately required a static discriminant. Its diagnostic offers a
checked cast as the remedy, which is right in general and useless for a value
that is heterogeneous by design — React's children are element, string, number,
array, iterable, thenable, portal or lazy, and the brand is what tells them
apart.

## Symbols box by reference

`SCR_DYN_SYMBOL` joins the kind enum LAST, because the LLVM backend hardcodes
every preceding kind number — the constraint `SCR_DYN_TYPED_REF` had documented
for itself, now inherited rather than broken.

It boxes by REFERENCE, the `SCR_DYN_HANDLE` stance, and for a sharper reason: a
symbol IS its identity, so a deep copy would forge a different symbol and
destroy the only property the value has. `ScrSym` was already refcounted,
immutable and cycle-free, so it needed no new lifetime machinery.

The kind owes what every other kind documents, and JS answers all of it: typeof
is `"symbol"`, truthiness is constant true, JSON drops it exactly as it drops
functions (absent from objects, null in array slots), `dynCheck` unwraps the
retained identity, and strict equality compares the pointer — so one symbol
boxed twice is one value, and `Symbol.for` interning survives the crossing.

**The gated-unit constraint was the part that bit.** `scr_json.c` is always
linked; `scr_symbol.c` is linked only when a program uses symbols. A release
arm calling `scr_sym_release` directly broke the link for every symbol-free
program. The promise and jsval kinds had already solved this — an allocator
view that installs a release function pointer — so the constructor lives in the
gated unit, hands the allocator an already-retained pointer, and the
always-linked core never names the symbol unit at all.

## Dispatch is the same desugar unions already had

`lowerUnionSwitch` was already a careful if/else-chain desugar with the rules
that make one honest: trailing-break-only exits, no fall-through between
bodies, pure case tests, one shared lexical scope. None of that is
union-specific, so it became `lowerSwitchChain`, parameterized by how a single
case test becomes a condition. Unions build `unionEq`; dynamic discriminants
build `dynScalarEq`, which already routed both-dyn compares to the runtime's
whole-value equality — the one that now knows about symbols.

One difference is not cosmetic. The union desugar requires a re-emittable
discriminant because the chain re-reads it per test. A dynamic read is not
re-emittable in general: an island-backed value runs an engine getter and a
handle read runs its ops. So the dynamic entry binds the discriminant to a
local once and tests that, which is what `switch` itself does — the desugar
moving toward JS rather than away from it.

## The third item was not the compiler's

Register reuse — one minifier name holding a boolean, then a string, then a
returned counter — is a source problem, and the fix belongs where the
information was destroyed. A transform splits a reused binding into one binding
per lifetime, on a rule narrow enough to need no dataflow pass: only a simple
assignment appearing as a TOP-LEVEL statement of a function body starts a new
lifetime, because that position sits inside no loop and control flow cannot
re-enter above it.

Two shapes are refused, and the second was found by the behavioural gate rather
than by reasoning: compound assignment (`x += e` reads the old value), and any
plain assignment whose right-hand side reads the binding. `updateQueue =
updateQueue.shared` looks like a boundary and is not; splitting it emitted
`let updateQueue$1 = updateQueue$1.shared`, which throws on its own
initializer. The counter fixture caught it immediately. Captured bindings are
refused too, since a closure could observe either lifetime.

## Evidence

The parent gate — which builds real GTK applications through both backends —
passes at 365 of 366 with one skip, both before and after the switch
generalization. The sanitizer gate passes 178 of 178 with no ASan finding and
no reference-audit imbalance, and a 500-iteration churn that boxes symbols both
bare and inside records runs clean under ASan plus the audit — the check that
matters for a kind whose payload is refcounted. A differential harness holds React's
rewritten entry points at 29 of 29 identical against the pristine pinned build,
and the behavioural control (counter, effect, host event, unmount) is unchanged.
A dispatch fixture answers identically to Node across registered symbols, an
independently-derived `Symbol.for`, string and number cases, an unregistered
symbol, and null.

Seven files, 222 insertions.

## What is left

Eight fences, and none is the shape 0058 predicted would dominate. Two remain
register reuse in positions the conservative rule refuses — one inside a switch
case, one inside a comma-expression — and both would need dominance analysis
rather than the lexical rule.

`.call` on a callee that ignores `this` is still open and is worth less than it
looked: the callee is a parameter, so proving the body never reads `this` needs
the concrete instantiation, not the type.

`toString(36)` is deliberately NOT a compiler item, and that judgement is the
transferable part. ECMA-262 leaves Number::toString implementation-defined for
a fractional value at any radix other than 10, so a static lowering would
commit the compiler to one engine's answer for inputs the spec does not pin.
React's index is a non-negative integer, where the conversion IS pinned, so it
belongs in a source transform that can state that precondition — verified
against the engine over 0..100000 and the power-of-two boundaries.
