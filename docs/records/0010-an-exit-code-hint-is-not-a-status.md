# 0010 — An exit-code hint is not a status

Status: accepted finding, gated on both targets
Last revised: 2026-08-20

This records a mistake both shipping targets made independently, in different
places, for the same reason — and the property that would have caught either
one on the day it was written. It is normative for any target that ends a
process.

## The claim

`scr_exit_code_note` records a *hint*. It feeds exit listeners and the
abnormal termination paths. **A normally exhausting `main` returns its program
verdict without consulting it**, on both the C and the LLVM backend.

So a target that wants a failure to end the process non-zero must say so
through the loop:

- by making the attached poll answer `SCR_ATTACHED_LOOP_POLL_FAILED`, which
  makes `scr_loop_run` return true, which the emitted `main` returns as 1; or
- by taking a terminal exit through `scr_process_exit`, which runs the exit
  listeners and does not return.

Noting the hint and then returning normally is not a third option. It is the
bug.

## How both targets got it wrong

**GTK** noted the hint in its failure sink and *also* marked the runtime
failed. The mark is what carried the status; the note was dead weight. The
target was correct by accident of having two mechanisms where one was load
bearing, and nothing said which.

**The JVM** noted the hint from its queued-callback pump and let a later
completion decide the exit code. Two defects sat on top of each other: the
note never reached the status at all, and `scr_exit_code_note` is
last-write-wins, so a later `complete(0)` overwrote a recorded failure. The
happy-path assertions had all passed because both sides were zero.

## Why it survived

Because a passing test proves nothing about a path it never takes. Every
assertion on both targets asserted status 0 on a run that succeeded. Zero is
what you get from a correct program, from a program whose hint was ignored,
and from a program whose handler never ran at all. One observation, three
readings, and the suites could not distinguish them.

## What is required

A target that can fail asynchronously must gate the failing path, not only the
succeeding one, and the gate must be able to tell "the handler failed" from
"the handler never ran". Asserting stdout alongside status is the cheap way:
a handler that was never reached leaves it empty.

Both targets are now gated this way, and both gates were **proven by mutation**
rather than by reading. Deleting the one line that marks the GTK runtime
failed — leaving the hint as the only signal — makes the application print its
uncaught error to stderr and exit 0. That is the JVM's bug, reproduced on GTK,
and it is what establishes the claim at the top of this document rather than
merely asserting it.

## What this does not say

It does not say the hint is useless. It is the input the abnormal paths and
the exit listeners read, and a target that exits through `scr_process_exit`
needs it to carry the right value. It says only that recording it is not the
same as returning it, and that no amount of care at the recording site
substitutes for a path that reaches the process.
