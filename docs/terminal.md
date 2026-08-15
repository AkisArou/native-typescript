# Terminal Application Environment

Status: normative direction; implementation not started  
Last revised: 2026-08-15

This document defines how Native TypeScript builds interactive terminal
applications. A terminal environment is a composition over an operating-system
target, not an ABI target, JavaScript compatibility realm, or React-specific
backend.

The key words **must**, **must not**, **should**, and **may** are normative.

## Decision

Native TypeScript owns a target-independent terminal session, protocol engine,
screen model, input model, and direct TUI toolkit. It does not use curses,
ncurses, Ink, or another terminal library as its permanent semantic foundation.

Raw bindings for such libraries may exist as ordinary optional binding
packages. They do not define the behavior of `@native-typescript/terminal` or
`@native-typescript/tui`.

The architectural stack is:

```text
                         application
                              │
              ┌───────────────┴────────────────┐
              │                                │
        direct TUI API                  React renderer
              │                                │
              └───────────────┬────────────────┘
                              ▼
                   shared TUI scene tree
                 layout / focus / semantics
                              │
                              ▼
                TerminalSession + Screen
             input parser / capabilities / diff
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
       POSIX terminal transport      Windows terminal transport
       termios, fd I/O, resize       console or ConPTY/pipe mode
               │                             │
               └──────────────┬──────────────┘
                              ▼
                 negotiated VT-family protocol
                              │
                              ▼
                       terminal emulator
```

ECMA-48 defines a broad repertoire of coded control functions, not a universal
widget API or one profile every emulator implements. DEC, VT, xterm, and newer
terminal protocols add overlapping extensions. X/Open Curses is a standardized
character-screen API and ncurses is an important implementation and reference,
but neither changes this ownership boundary.

Normative external references include:

- [ECMA-48](https://ecma-international.org/publications-and-standards/standards/ecma-48/);
- [X/Open Curses](https://pubs.opengroup.org/onlinepubs/7908799/xcurses/curses.h.html);
- [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html);
- [terminfo](https://invisible-island.net/ncurses/man/terminfo.5.html);
- [Windows console virtual-terminal sequences](https://learn.microsoft.com/windows/console/console-virtual-terminal-sequences).

## Target and product composition

The executable target continues to identify the actual ABI and toolchain:

```text
linux-x86_64
linux-aarch64
darwin-arm64
windows-x86_64
```

Terminal support is an application-environment profile composed onto that
target. The profile contributes public packages, transport bindings, runtime
event sources, protocol/profile artifacts, and executable requirements through
ordinary target planning.

A user-facing preset such as `terminal-linux-x64` may expand to an OS target
plus the terminal profile. It must not become a second internal ABI identity or
select a competing runtime provider.

The terminal emulator is normally selected at application run time. Build
reproducibility therefore fixes the implementation, protocol/profile data, and
Unicode data used by the executable; it does not pretend every runtime terminal
has identical behavior.

## Package boundaries

The intended stable public boundaries are:

- `@native-typescript/terminal`: `TerminalSession`, terminal capabilities,
  input events, screen/cell presentation, and protocol behavior;
- `@native-typescript/tui`: the target-independent scene tree, layout, focus,
  interaction, widgets, and application lifecycle;
- `@native-typescript/react-terminal`: an optional actual-React renderer that
  produces the same TUI scene tree;
- raw platform or library packages such as `@native-typescript/posix`, Windows
  console bindings, or `@native-typescript/ncurses` when explicitly requested.

Transport implementations belong with the relevant OS target integration. The
repository must not create separate terminal target packages merely to conceal
POSIX or Windows calls. `terminal-protocol` and `terminal-core` remain internal
module boundaries until independent package ownership is proven.

## Terminal session

A `TerminalSession` owns one coherent interaction with explicit input and
output endpoints. Standard input and output are defaults, not ambient
assumptions: they may be separate devices, redirected streams, PTYs, console
handles, or pipes.

Opening is transactional. It either establishes the requested session and
records every obligation, or rolls all changes back before reporting failure.
The conceptual state machine is:

```text
opening → active ⇄ suspended → closing → closed
   │          │
   └──────────┴──────────────→ failed
```

The session may own:

- saved POSIX terminal attributes or Windows console modes;
- active protocol modes and their restoration actions;
- alternate-screen and cursor state;
- input, output-readiness, resize, signal, and timer registrations;
- negotiated capabilities and outstanding query responses;
- parser storage, pending output, and the last presented screen;
- a lease preventing incompatible sessions from controlling the same device.

`close()` is the idempotent domain operation. Normal last-reference release is
a safety net, not the primary correctness mechanism for externally visible
terminal state. Runtime shutdown closes active sessions before stopping the
owner executor.

On POSIX systems, job-control suspension must restore the terminal before the
process stops and re-establish the session after continuation. Equivalent
platform lifecycle events use the same state transition. No API may promise
restoration after `SIGKILL`, process memory corruption, abrupt machine loss, or
an emulator that has already disconnected.

Full-screen and inline presentation are distinct modes. Full-screen ownership
must reject uncoordinated writes through `console`, standard output, or a second
screen renderer unless the session explicitly brokers them.

## Platform transports

### POSIX

The initial POSIX transport uses a narrow native surface:

```text
isatty
tcgetattr / tcsetattr
read / write
poll-set registration
terminal size query
resize and job-control signal integration
```

The adapter retrieves and modifies the existing terminal attributes rather
than constructing a zero-filled `termios` value. POSIX Issue 8
`tcgetwinsize()` may be used when the selected SDK provides it; deployed SDKs
that lack it use an authoritative `ioctl(TIOCGWINSZ)` adapter. Size retrieval
does not provide resize notification: the transport must integrate `SIGWINCH`
or the platform-equivalent event source with the owner wait set.

Input and output descriptors may be nonblocking. Partial reads, partial writes,
interruption, hangup, and output backpressure are ordinary transport states,
not fatal assumptions hidden beneath `present()`.

### Windows

New output uses virtual-terminal sequences where the selected environment
supports them, matching Microsoft's current platform direction. Windows still
requires two transport modes:

1. **Attached console.** The adapter snapshots console modes, enables the
   required VT output processing, and may use `ReadConsoleInputW` to preserve
   exact keyboard, mouse, focus, and resize records that byte-oriented console
   reads filter out.
2. **ConPTY, pipe, SSH, or redirected stream.** Input and output are byte
   streams; console-mode APIs may not apply. The common incremental protocol
   parser consumes input sequences and the enclosing terminal or pseudoconsole
   owns resize delivery.

Both transports normalize into the same terminal input and resize events.
Classic Windows screen-buffer drawing is not the portable rendering model, but
the limited console API required to establish, observe, and restore an attached
console remains a legitimate transport mechanism.

## Shared owner wait set

Terminal support must not run a private blocking input loop. The ScriptC
runtime owns one generic event-source/wait-set contract that combines:

- terminal input readiness;
- output readiness and backpressure;
- resize and process-signal delivery;
- input-sequence ambiguity and capability-query deadlines;
- ScriptC timers and microtasks;
- owner-gateway wakes;
- sockets, pipes, child processes, filesystem watches, and later I/O sources.

The host dispatcher performs at most one host turn or a bounded batch and then
returns to the ordinary ScriptC checkpoint. A terminal-specific need that
reveals a missing polling, readiness, signal, or fairness primitive is fixed in
the generic ScriptC runtime rather than duplicated inside the terminal package.

## Protocols and capabilities

The protocol engine uses three evidence layers:

```text
conservative baseline
        +
terminfo or selected profile data
        +
explicitly negotiated extensions
```

Environment values such as `TERM` and `COLORTERM` are untrusted selection
hints. They never prove support on their own. Terminal queries share the input
channel with keyboard and paste input, so the engine must route responses by a
bounded state machine with deadlines and preserve unrelated input ordering.

Capabilities are immutable after session negotiation unless a declared runtime
event invalidates them. Each fact records its evidence class conceptually:

```ts
interface TerminalCapability<T> {
  readonly value: T;
  readonly evidence: "baseline" | "profile" | "query";
}
```

The concrete representation may compress this data but must preserve its
diagnostic meaning. Environment hints used to select a candidate profile are
reported separately and never become capability evidence. Capability families
include color depth, cursor movement, alternate screen, bracketed paste, focus
events, mouse protocols, keyboard protocols, synchronized output, hyperlinks,
and explicitly privileged control families such as clipboard access.

An optional embedded terminal database is a versioned, content-addressed build
artifact with provenance and licensing. The initial implementation may instead
ship a deliberately small set of reviewed profiles plus conservative fallback.
Unsupported capabilities remain false or produce precise diagnostics; the
engine does not optimistically emit a sequence because a terminal name looks
familiar.

## Input model

Input parsing is incremental across arbitrary read boundaries. The parser
recognizes only declared, bounded protocol grammars and emits normalized events
such as:

```ts
type TerminalInputEvent =
  | KeyEvent
  | TextEvent
  | PasteEvent
  | MouseEvent
  | FocusEvent
  | TerminalResponseEvent;
```

Legacy input contains unavoidable ambiguity: `Escape`, an Alt-modified key,
and the beginning of a control sequence may share a prefix. The session's
profile declares its bounded disambiguation deadline. Negotiated enhanced
keyboard protocols may remove ambiguity but must not be assumed.

Paste, control-string, numeric-parameter, and pending-sequence sizes are
bounded before allocation. Malformed or oversized input cannot grow memory
without limit or be reinterpreted as a different event class. Capability
responses and user input retain their relative stream order even when response
handling is internal.

## Screen and presentation

Applications and UI toolkits render desired state into a logical cell screen.
`present()` compares desired state with the last known terminal state and emits
the minimum proven-safe update under the selected capabilities.

The renderer accounts for:

- dirty regions and complete invalidation after resize or uncertain output;
- cursor position, visibility, shape, and style state;
- style reset and color capability;
- terminal autowrap and the bottom-right cell;
- width-two glyph continuation cells and overwrite repair;
- partial writes, buffered output, and synchronized presentation when proven;
- inline versus alternate-screen behavior.

Application text is data, never terminal syntax. C0/C1 controls, ESC, CSI, OSC,
DCS, and related introducers are sanitized or represented through explicit
APIs. Clipboard, title, hyperlink, notification, and graphics operations each
require an explicit capability and cannot be smuggled through a text node.

## Unicode and cell width

JavaScript string length, Unicode code-point count, extended grapheme count,
UTF-8 byte length, and terminal display width are distinct.

The terminal engine pins one Unicode version and uses:

- the default extended-grapheme rules from
  [UAX #29](https://unicode.org/reports/tr29/), or a precisely named profile;
- version-matched Unicode property data, including
  [UAX #11](https://unicode.org/reports/tr11/) East Asian Width;
- an explicit terminal-width policy for ambiguous characters, emoji,
  variation selectors, combining-only clusters, and known terminal divergence.

East Asian Width is evidence, not a complete terminal-width oracle. Actual
glyph advance can depend on terminal fonts and implementation policy. The
selected width profile is therefore visible in capabilities and diagnostics.

Conceptually, a rendered glyph records:

```ts
interface GlyphCell {
  readonly grapheme: string;
  readonly width: 0 | 1 | 2;
  readonly style: CellStyle;
}
```

The concrete grid uses a distinct continuation marker for the second cell of a
width-two glyph. Invalid UTF-16, isolated combining sequences, clipping, and a
width-two glyph at the final column have deterministic documented behavior.
Unicode tables are generated, versioned artifacts and must pass the matching
Unicode conformance data.

## Direct TUI and React

`@native-typescript/tui` is the Android-like application API for terminals. It
owns a headless scene tree, text measurement, layout, focus traversal, input
routing, interaction state, and widgets. It can be used without React.

The layout implementation is replaceable. Yoga is a credible native layout
provider, especially for React compatibility, but it is not part of terminal
protocol or session semantics. A Yoga binding must pass its own ownership,
size, performance, and conformance review before becoming a shipped dependency.

`@native-typescript/react-terminal` uses actual pinned React and reconciler
revisions under the common React compatibility gate. Its host nodes produce the
same TUI scene tree and consume the same terminal session, scheduler, ownership,
and artifact contracts as direct code. It has no privileged compiler hook.

Similarity to Ink is an API-design input, not an automatic compatibility claim.
Any Ink compatibility promise names a version and differential suite.

## Build artifacts and reports

A terminal application may add these artifact kinds or resources:

- pinned Unicode property and conformance-data revisions;
- reviewed terminal profiles or an embedded terminfo-derived database;
- generated POSIX or Windows transport adapters;
- optional layout-provider libraries such as Yoga;
- protocol, capability, and TUI conformance reports.

The build report records which artifacts are embedded. Runtime diagnostics
record endpoint kinds, selected transport, negotiated profile, capability
evidence, Unicode/width policy, rejected input, restoration failures, and
pending output at shutdown without leaking user input contents by default.

## Initial permanent slice

The first terminal phase targets a POSIX PTY-backed executable and implements:

- transactional raw/full-screen lifecycle and normal/suspend restoration;
- keyboard, resize, and bounded bracketed-paste input;
- a conservative VT-family profile with precise refusals;
- the pinned grapheme and cell-width model;
- cell presentation and deterministic frame diffing;
- direct non-React TUI layout, focus, and a counter application;
- shared wait-set ordering, microtask checkpoints, and shutdown;
- C and LLVM backends with no JavaScript engine.

Mouse protocols, advanced keyboard negotiation, synchronized output, system
terminfo breadth, graphics, clipboard access, and Windows transport may follow
as permanent extensions. Unsupported forms fail or remain disabled; the first
slice does not emulate them incompletely.

## Conformance gates

The terminal suite includes:

- PTY-driven fragmented input and partial output;
- normal, exceptional, shutdown, suspend, and resume restoration;
- non-TTY and disconnected-endpoint diagnostics;
- input ambiguity deadlines and capability-response multiplexing;
- bounded malformed, paste, OSC, CSI, and numeric input;
- resize during presentation and width-two overwrite behavior;
- pinned Unicode segmentation and width fixtures;
- text/control injection separation;
- owner-turn, timer, microtask, and fairness ordering;
- direct TUI focus, update, and teardown;
- byte-equivalent C and LLVM observable behavior;
- sanitizer, leak, and terminal-state restoration checks.
