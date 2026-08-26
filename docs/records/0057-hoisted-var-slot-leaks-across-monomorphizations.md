# 0057 — A hoisted `var` slot leaks across monomorphizations

Status: reproduced and root-caused in the fork; unfixed  
Recorded: 2026-08-25

Measuring how much of pinned React compiles statically turned up an internal
compiler error rather than a fence. It is recorded here because the reduction
is small, the cause is exact, and the shape that produces it is ordinary
JavaScript that any bundled dependency can contain — this is not a React
problem that happened to surface in the compiler.

## What fails

```
SC9001: internal compiler error: in %m0.mapChildren%1:
        assign to undeclared local/global "result.0" — please report this
```

The IR validator raises it (`ir/validate.ts`, the `assign` arm) because the
lowerer emitted a function body that assigns a slot the body never declared.
The `%1` is the second monomorphization of the function. Nothing reached a
backend; the validator is the reason this is a crash rather than a miscompile.

## The reduction

Seventeen lines, reduced from React 19.2.8's `Children.map`, which has this
shape exactly. Node runs the same input and answers `2`.

```js
function mapIntoArray(children, array, cb) {
  array.push(cb(children));
}
function mapChildren(children, func, context) {
  var result = [],
    count = 0;
  mapIntoArray(children, result, function (child) {
    return func(child, count++);
  });
  return result;
}
exports.go = function (n) {
  var a = mapChildren(n, function (c, i) { return c + i; }, null);
  var b = mapChildren("x", function (c, i) { return c + i; }, null);
  return a.length + b.length;
};
```

Three conditions are jointly required: a `var` that must be hoisted because a
nested closure captures it, a function monomorphized more than once, and
instantiations that genuinely differ, so the differing type reaches the
instantiation signature. Holding everything else fixed and varying only the
call-site arguments:

| two call sites, arguments | result |
| --- | --- |
| `mapChildren(n, …)` / `mapChildren("x", …)` — `string` against `"x"` | ICE |
| `mapChildren("x", …)` / `mapChildren("x", …)` — identical | compiles |
| `mapChildren(n, …)` / `mapChildren(n, …)` — identical | compiles |
| one call site | compiles |

`Function.prototype.call` is not involved; a plain call reproduces it. The
type difference that suffices is a `string` parameter against a `"x"` literal,
which is the practical finding: real bundles reach this constantly and a
contrived test unifies the two instantiations and misses it.

## Cause

Two pieces that are each defensible and wrong together.

`lowerVarDecl` always emits an assignment for `var x = e`, trusting that the
slot has already been declared at the function root:

```ts
const local = hoistVarBinding(L, declSymbol, decl.name);
if (!decl.initializer) return null;
return { kind: "assign", localId: local.id, value: init, loc: locOf(decl) };
```

`hoistVarBinding` is memoized on the `ts.Symbol`, and the memo hit returns
without pushing a `varDecl`:

```ts
const existing = L.hoistedVars.get(symbol);
if (existing) return existing;
```

`hoistedVars` is a `Map<ts.Symbol, IrLocal>` field on the `Lowerer` that is
never cleared, and a `Lowerer` is constructed once per pass — validation,
emit, remainder — never per instantiation. So one memo serves every
monomorphization in the program:

```
instantiation %0 : miss → mint result.0, push its varDecl into %0, memoize
instantiation %1 : HIT  → return %0's IrLocal, push nothing
                   lowerVarDecl still emits `assign result.0`
                   → %1 assigns a local %1 never declared
```

The key is per-declaration and the value is per-instantiation. Those are
different scopes, and a `ts.Symbol` cannot distinguish them.

## The part worth checking before fixing

`hoistVarBinding` carries `local.type` forward as well, and `lowerVarDecl`
types the initializer against it:

```ts
const init = L.lowerExprExpecting(decl.initializer, local.type);
```

Instantiation `%1` therefore lowers its initializer against `%0`'s type. Here
that produced a dangling identifier and a loud failure. Whether a shape exists
where the identifier lines up but the types differ — lowering quietly against
the wrong type — has not been established, and should be before the crash is
patched. A silently wrong lowering is the defect this project treats as real
even when the output still compiles; the ICE may be the visible corner of it.

## Direction

Key the hoist memo per instantiation so each monomorphization mints and
declares its own slot. The regression test belongs with the general `var`
semantics, not with a React-shaped fixture: two instantiations of a function
whose `var` is captured by a nested closure.

## Standing in for the fix

None in the compiler. The React measurement works around it from the source
side by narrowing `var` to `let` wherever the two are provably
indistinguishable — every reference inside the declaration's block, no
reference before the declaration, exactly one declaration for the symbol, and
no for-initializers — because `let` does not take the hoisting path. That
cleared React (376 declarations narrowed, 96 refused) and is worth nothing as
a fix: a `var` that genuinely relies on function-scope hoisting still reaches
the defect, and those are precisely the declarations the narrowing refuses.
