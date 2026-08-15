# Runtime and Threading

Status: normative  
Last revised: 2026-08-15

This document defines the runtime-instance, scheduling, callback, and shutdown
model shared by all targets.

## Runtime instance

A `RuntimeInstance` owns:

- one ScriptC heap and its reference/cycle state;
- global and module state;
- the promise and microtask queues;
- timers and target event sources registered with the instance;
- native handle and callback tables;
- one owner executor;
- a thread-safe foreign-event ingress queue;
- error, trap, and diagnostic sinks;
- an explicit lifecycle state.

Ordinary heap values belong to exactly one runtime instance. They are neither
read nor mutated by another instance or a foreign thread.

## Owner executor

Every instance is bound at creation to exactly one owner executor. The owner may
be:

- the current thread and an attached event loop;
- the Android main Looper;
- an Apple main run loop or dispatch queue;
- a Windows dispatcher/apartment;
- a GLib main context;
- a Chromium sequence;
- a dedicated ScriptC thread.

Only callbacks running on the owner executor may enter compiled TypeScript,
drain microtasks, access heap values, mutate the handle table, or finalize
ScriptC-owned resources.

Owner identity is a runtime assertion in checked builds, not only compiler
metadata.

For initial native UI targets, the runtime owner is the platform UI executor.
This makes host-view access and TypeScript state updates sequential. CPU work
that must run concurrently uses a separate runtime instance or native worker
with explicit value transport.

## No shared ScriptC heap

Multiple instances may run in parallel, but ordinary ScriptC objects never
cross between them. Values are copied through the transport-safe algebra or
represented by explicit remote/native handles.

This preserves the current single-threaded runtime design while allowing native
applications to use concurrency. It also prevents a platform callback from
turning every reference-count operation and object mutation into a shared-memory
synchronization problem.

Shared native buffers may be introduced only as a separate type with specified
atomicity, ownership, and synchronization. They are not ScriptC arrays.

## Scheduler gateway

Foreign work enters an instance through a multi-producer, single-consumer
gateway:

```text
foreign callback/thread
        │
        │ validate callback token
        │ copy/retain ABI-safe arguments
        ▼
thread-safe ingress queue
        │
        │ wake owner executor
        ▼
owner drains ingress
        │
        │ validate generation and lifecycle again
        ▼
compiled callback + microtasks
```

Producers cannot hold pointers into the ScriptC heap. A gateway event owns all
of its copied payload and releases it if delivery is rejected.

The target's scheduler adapter provides a non-blocking wake operation. Multiple
wakes may be coalesced, but admitted events retain FIFO order per producer.
Global ordering between independent foreign producers is the order in which the
gateway atomically admits them; applications must not derive semantic meaning
from competing external threads unless the native API specifies ordering.

The ScriptC fork implements the generic queue and lifecycle foundation as an
instance-owned `ScrOwnerGateway`. Admission transfers ownership of an intrusive,
transport-owned event record; rejection, delivery, and shutdown each destroy it
exactly once. Target wakes are coalesced, owner drains may be budgeted, and an
interrupted detached batch is restored ahead of later admissions. The running,
stopping, and stopped transitions are linearized with admission, including
reentrant stop/discard during delivery. Threaded and ASan/UBSan tests cover
producer FIFO, races, reentrancy, and destruction accounting.

This primitive does not itself retain a ScriptC closure or enter compiled code.
The callback-token/owner table, generated copied ABI payload records, retained
callback service, target wake adapter, and owner-loop policy remain separate
layers built on it. All but the concrete target wake adapter are now present in
the first exact-scalar callback slice.

## Callback tokens

A native callback entry is identified by an opaque token containing a table
slot and generation. Its conceptual state is:

```text
active → closing → disposed
   └──────────────→ disposed
```

The entry owns:

- compiled closure and captures;
- native ABI signature;
- lifetime mode;
- owner runtime and delivery executor;
- cancellation binding/state;
- admitted invocation count;
- reentrancy and shutdown policy.

The ScriptC fork implements the transport half of this model. An opaque token
carries immutable slot, generation, gateway, and ABI-signature identity plus a
single atomic state/lease word. Admission and the active-to-closing transition
therefore have one linearization order: a winning invocation owns a lease until
its copied event is delivered or destroyed; a losing invocation destroys its
payload immediately. Native cancellation completion and token destruction are
separate owner operations, and destruction cannot succeed while any lease
exists. The race fixture passes plain, ASan/UBSan, and Linux TSan gates.

The token intentionally contains no closure pointer. The ScriptC fork's
owner-only table maps slot/generation/signature identity to a validated anchor,
permits already-admitted leases to find a closing entry, and advances slot
generations on reuse rather than wrapping. It owns the anchor during staging;
after association, the native-handle lifecycle owns it and the table keeps only
the owner-thread lookup pointer. On ordinary cancellation with pending leases,
the table temporarily resumes ownership through the last delivery.

An active `until-cancelled` registration keeps its callback alive. A lean
result-owned handle expresses that as an external root. A receiver-owned
registration instead traces receiver-to-result and result-to-closure edges, so
an otherwise unreachable cycle can be collected.
Native IR and both backends now generate copied exact-scalar invocation records
and ABI thunks. Foreign thunks see only the opaque token; owner dispatch resolves
the closure from the table and converts the payload on the owner.

The native-handle association is implemented in the ScriptC runtime. A
generic native-handle lifecycle edge runs every begin hook before clearing and
destroying the foreign resource, then runs completion hooks after the destructor
has quiesced native callbacks. The callback specialization claims a staged table
entry, closes token admission in the begin hook, marks native cancellation
complete afterward, and opportunistically collects the entry. Reentrant or
repeated handle disposal sees the edge already detached and is harmless.

Receiver association preallocates its ownership link before entering native
code, adopts the returned connection without allocation, and rolls the link
back with a failed nullable result. Explicit connection cancellation detaches
that shared link idempotently. Receiver destruction disconnects every child;
collector destruction discards admitted deliveries before freeing the traced
closure, so foreign-thread tokens never observe reclaimed managed memory.

The conformance test attempts another native callback from inside the foreign
destructor and verifies that it is rejected, while an invocation admitted
before disposal remains deliverable and keeps the anchor rooted. The same test
runs plain and under ASan/UBSan and TSan.

### Admission

Foreign admission atomically validates the token and acquires an invocation
lease. Successful admission owns a copied payload. A stale, closing, or disposed
token is rejected without accessing the ScriptC heap.

### Disposal

Disposal marks the entry closing, invokes the native cancellation operation
when required, and prevents new admissions. Invocations admitted before closing
remain deliverable during ordinary explicit or last-reference cancellation.
Cycle collection instead marks those invocations for discard before reclaiming
the traced closure. The entry becomes disposed and increments its generation
after all leases finish.

This rule avoids pretending cancellation can recall an event already delivered
by a native system. A binding whose native API guarantees stronger cancellation
may expose it, but the generic runtime does not assume it.

### Lifetime modes

- `call`: synchronous, same-thread, valid only during the native call.
- `once`: at most one invocation wins admission; the entry then closes.
- `retained`: remains active until explicit disposal or owner cleanup.
- `weak`: delivery occurs only while the referenced ScriptC owner remains alive.
- `until-cancelled`: retained and associated with a required native cancellation
  operation.

Call-scoped callbacks may return a value synchronously when they execute on the
owner executor and the binding permits reentrancy.

Initial foreign-thread callbacks must return `void` at the native ABI. Blocking
a foreign thread while the owner executes TypeScript is not supported. A future
synchronous cross-thread model requires its own deadlock, reentrancy, timeout,
and shutdown specification.

## Argument transport

Call-scoped same-owner callbacks may borrow values for their dynamic extent.
Retained or foreign callbacks accept only values that can be copied or retained
without accessing the ScriptC heap from the producer thread:

- exact scalars and booleans;
- copied strings and byte sequences;
- copied native aggregates with safe fields;
- thread-safe native handles explicitly declared transferable;
- platform references retained by a target adapter under its native rules.

The owner creates ScriptC values from the payload during delivery. Conversion
failure produces a callback error event; it never executes the closure with a
partially initialized value.

## Tasks and microtasks

The owner loop observes this abstract order:

1. finish the current ScriptC/native entry turn;
2. drain ScriptC microtasks to the specified quiescence point;
3. return to the host scheduler;
4. accept the next host task or a bounded batch of gateway events;
5. run each delivered callback as a turn, applying the microtask rule between
   turns.

Targets may batch gateway dequeues for performance, but must not starve host UI,
I/O, or higher-priority work. The exact fairness budget is target policy and is
observable in diagnostics, not language semantics.

The ScriptC runtime enforces the turn boundary with two host-facing operations.
Retained-callback dispatch consumes at most one event and reports idle,
delivered, or pending-exception status. The loop checkpoint drains nextTicks and
promise/microtask jobs to joint exhaustion, decides unhandled rejections, and
runs scheduled cycle collection without polling ScriptC's standalone host loop.
A target source repeats dispatch then checkpoint within its fairness budget and
returns control to the platform scheduler afterward. Shutdown separately stops
admission, delivers through the same turn path or discards payloads, and destroys
the service only after cancellation and leases quiesce.

For executable targets, the platform dispatcher is also a first-class ScriptC
loop source. Its pending predicate participates in liveness, and its poll
operation runs at most one host turn before returning control to ScriptC. The
poll receives ScriptC's next timer deadline, or no deadline when none exists.
This makes top-level TypeScript initialization return normally while the host
loop owns application waiting; no compiled native call remains suspended around
the UI loop. A host dispatcher cannot compose safely with ScriptC's independent
fd pollers until both share one wait set, so that combination fails explicitly
instead of using latency-prone periodic polling.

A platform promise/future adapter settles a ScriptC promise by posting a
gateway event. It does not resolve the promise directly on the platform thread.

## Scheduler hops

Bindings declare required executors. A call has one of these behaviors:

- **require**: reject unless already on the executor;
- **dispatch async**: return a promise and schedule the operation;
- **dispatch sync**: allowed only for target-proven safe cases without a
  privilege or deadlock inversion;
- **any executor**: execute directly subject to ownership constraints.

The compiler never silently turns a synchronous source API into an asynchronous
one. If a hop is required, the declaration exposes a promise or an explicit
scheduler operation.

## Reentrancy

Native APIs may call back synchronously while a native call is active. Binding
metadata declares whether this is possible.

The runtime supports owner-thread reentrancy only at checked entry points that:

- establish a nested native-call frame;
- preserve temporary borrows;
- prevent destruction of active native call state;
- run the specified microtask policy after the outermost turn, not an arbitrary
  nested callback;
- translate exceptions through the native callback ABI.

Unexpected reentrancy is a binding-contract violation and traps in checked
builds.

## Lifecycle

An instance moves through:

```text
created → running → stopping → stopped
```

- `created`: tables exist; application entry has not run.
- `running`: tasks and callback admissions are accepted.
- `stopping`: new external registrations and admissions are rejected; native
  registrations are cancelled; admitted work is drained or discarded according
  to its declared shutdown policy.
- `stopped`: no TypeScript execution is possible; all handles, callbacks, and
  payloads have been released or reported as leaks.

Shutdown is idempotent and executes on the owner executor. A target lifecycle
event may request shutdown from another thread only by posting to the gateway.

An application host must keep the runtime instance alive for at least as long
as any exported native entry or callback token can be used. Generated adapters
own an explicit instance reference; they do not rely on a process-global
singleton unless the target application model declares exactly one instance.

## Platform integration requirements

### Android

The adapter owns `JavaVM`, obtains a thread-local `JNIEnv`, attaches native
threads when necessary, uses global or weak-global references for retained
objects, releases local references in bounded frames, checks pending exceptions,
and dispatches UI work through the main Looper.

### Apple

Generated Objective-C++ observes ARC method families, establishes autorelease
pools on native-created threads/turns, retains blocks and objects according to
SCABI, and maps main-actor/main-queue requirements to the target executor.

### Windows

The adapter initializes the required COM apartment, preserves apartment/thread
affinity, dispatches through the selected UI dispatcher, and never releases a
COM reference from an invalid apartment when the binding forbids it.

### GTK/GObject

The adapter owns or attaches the correct `GMainContext`, observes floating
references, disconnects signals before releasing callback entries, and delivers
UI mutations on the owning context.

## Error boundaries

- No foreign language exception unwinds through ScriptC-generated frames.
- Generated adapters catch/observe platform exceptions and convert them using
  SCABI.
- A TypeScript exception crossing a synchronous native callback is translated
  to the callback's declared error convention; if none exists, it reaches the
  runtime error sink and the callback returns its ABI-safe failure value.
- Exceptions from asynchronous callback delivery reject an associated promise
  or reach the uncaught callback sink.
- Queue allocation failure follows a target-configurable fatal out-of-memory
  policy; it is never reported as successful callback delivery.

## Observability

Checked builds expose:

- runtime and owner-executor identity;
- queue depth and rejected admissions;
- callback creation, admission, delivery, cancellation, and disposal;
- handle counts and affinity violations;
- scheduler hops and latency;
- shutdown leaks;
- causal IDs joining native callbacks to TypeScript work.

Tracing must be removable or near-zero-overhead in optimized builds.

## Conformance tests

The common runtime suite includes:

- same-owner call-scoped callback and return value;
- retained callback delivery;
- concurrent foreign producers;
- once-callback admission race;
- disposal racing with admission;
- stale generation rejection;
- callback capture release;
- owner-executor assertion;
- promise ordering after native settlement;
- reentrant same-owner callback;
- shutdown with active callbacks and handles;
- multiple independent runtime instances;
- sanitizer and leak-detector runs.
