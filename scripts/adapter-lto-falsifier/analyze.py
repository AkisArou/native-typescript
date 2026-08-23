#!/usr/bin/env python3
"""Turns the falsifier's raw evidence into out/report.md.

Inputs (all produced by run.sh in the given directory):
  results-nolto.txt / results-lto.txt  VERIFY / COUNT / TIME lines
  falsifier-nolto.dis / falsifier-lto.dis  objdump -d of the final binaries
  jni-offsets.txt  function-table offsets probed from the real jni.h
  env.txt  host identification

The report never looks at intermediate IR: benchmarks, exact dynamic
operation counts, and final-assembly call sites only.
"""

import re
import statistics
import sys
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "out")

KERNELS = [
    "a_nonescaping",
    "b_nonescaping",
    "b2_nonescaping_batched",
    "a_stored",
    "b_stored",
    "a_fallible",
    "b_fallible",
    "env_lookup",
    "env_scoped",
    "env_passed",
]
CASES = [
    ("nonescaping", "a_nonescaping", "b_nonescaping"),
    ("stored", "a_stored", "b_stored"),
    ("fallible", "a_fallible", "b_fallible"),
]


def parse_results(path):
    verify, counts, times = [], {}, {}
    for line in path.read_text().splitlines():
        fields = dict(
            part.split("=", 1) for part in line.split()[1:] if "=" in part
        )
        if line.startswith("VERIFY "):
            verify.append((fields["check"], fields["ok"] == "1"))
        elif line.startswith("COUNT "):
            iters = int(fields.pop("iters"))
            kernel = fields.pop("kernel")
            fields.pop("tag", None)
            counts[kernel] = (
                iters,
                {op: int(n) for op, n in fields.items()},
            )
        elif line.startswith("TIME "):
            key = fields["kernel"]
            times.setdefault(key, []).append(
                int(fields["ns"]) / int(fields["iters"])
            )
    return verify, counts, times


def parse_offsets(path):
    table = {}
    for line in path.read_text().splitlines():
        name, off = line.split()
        table[int(off)] = name
    return table


FUNC_RE = re.compile(r"^[0-9a-f]+ <nt_kernel_([a-z0-9_]+)>:$")
CALL_DIRECT_RE = re.compile(r"call\w*\s+[0-9a-f]+ <([^>+]+)(?:\+0x[0-9a-f]+)?>")
CALL_TABLE_RE = re.compile(r"call\w*\s+\*0x([0-9a-f]+)\(%r\w+\)")
CALL_REG_RE = re.compile(r"call\w*\s+\*%(\w+)")
MOV_TABLE_RE = re.compile(r"mov\w*\s+0x([0-9a-f]+)\(%r\w+\),\s*%(\w+)")


def parse_disasm(path, offsets):
    """Per kernel: instruction count and a {call label: count} map."""
    funcs = {}
    current, insns = None, []
    for line in path.read_text().splitlines():
        m = FUNC_RE.match(line)
        if m:
            current = m.group(1)
            insns = funcs.setdefault(current, [])
            continue
        if current is None:
            continue
        if not line.strip():
            current = None
            continue
        parts = line.split("\t")
        if len(parts) >= 2 and parts[-1].strip():
            insns.append(parts[-1].strip())

    def slot_label(off):
        slot = offsets.get(off)
        if slot is None:
            return f"indirect(+0x{off:x})"
        if slot.startswith("VM_"):
            return f"vm->{slot.removeprefix('VM_')}"
        return f"env->{slot}"

    result = {}
    for name, body in funcs.items():
        calls = {}

        def add(label):
            calls[label] = calls.get(label, 0) + 1

        for i, insn in enumerate(body):
            if not insn.startswith("call"):
                continue
            m = CALL_DIRECT_RE.search(insn)
            if m:
                add(m.group(1))
                continue
            m = CALL_TABLE_RE.search(insn)
            if m:
                off = int(m.group(1), 16)
                add(slot_label(off))
                continue
            m = CALL_REG_RE.search(insn)
            if m:
                reg = m.group(1)
                label = "indirect(unlabeled)"
                for back in range(i - 1, max(-1, i - 16), -1):
                    mm = MOV_TABLE_RE.search(body[back])
                    if mm and mm.group(2) == reg:
                        off = int(mm.group(1), 16)
                        label = slot_label(off)
                        break
                add(label)
                continue
            add("indirect(unlabeled)")
        result[name] = (len(body), calls)
    return result


def fmt_ns(values):
    if not values:
        return "—"
    return f"{statistics.median(values):.1f} (min {min(values):.1f})"


def med(values):
    return statistics.median(values) if values else float("nan")


def main():
    offsets = parse_offsets(OUT / "jni-offsets.txt")
    runs = {}
    for tag in ("nolto", "lto"):
        runs[tag] = parse_results(OUT / f"results-{tag}.txt")
    dis = {
        tag: parse_disasm(OUT / f"falsifier-{tag}.dis", offsets)
        for tag in ("nolto", "lto")
    }

    print("# Adapter-plus-LTO falsifier — results")
    print()

    print("## Thread-capability carrier measurement")
    print()
    print("All kernels call `JNIEnv->GetVersion`. `env_lookup` also calls")
    print("`JavaVM->GetEnv` on every iteration; `env_scoped` reads the")
    print("reentrant TLS carrier used by the JVM target; `env_passed` is the")
    print("explicit-operand lower bound.")
    print()
    print("| binary | per-call lookup | scoped TLS | explicit operand | TLS saving |")
    print("| --- | --- | --- | --- | --- |")
    for tag, (_, _, times) in runs.items():
        lookup = med(times.get("env_lookup", []))
        scoped = med(times.get("env_scoped", []))
        passed = med(times.get("env_passed", []))
        print(
            f"| {tag} | {fmt_ns(times.get('env_lookup', []))} "
            f"| {fmt_ns(times.get('env_scoped', []))} "
            f"| {fmt_ns(times.get('env_passed', []))} "
            f"| {lookup - scoped:.1f} ns/op |"
        )
    print()
    print("Instrument: `scripts/adapter-lto-falsifier`. Specified by")
    print('`docs/foreign-boundary.md`, "The contingency".')
    print()
    print("```")
    print((OUT / "env.txt").read_text().strip())
    print("```")
    print()

    print("## Verification")
    print()
    all_ok = True
    for tag in ("nolto", "lto"):
        for check, ok in runs[tag][0]:
            all_ok &= ok
            print(f"- `{tag}` {check}: {'ok' if ok else '**FAILED**'}")
    if not all_ok:
        print()
        print("**At least one verification failed; numbers below are void.**")
    print()

    print("## Steady-state ns per operation (median over reps; lower is better)")
    print()
    print("| case | A adapter, no LTO | A adapter, LTO | B informed | B2 batched |")
    print("| --- | --- | --- | --- | --- |")
    _, _, t_nolto = runs["nolto"]
    _, _, t_lto = runs["lto"]
    for case, a, b in CASES:
        b2 = (
            fmt_ns(t_lto.get("b2_nonescaping_batched", []))
            if case == "nonescaping"
            else "—"
        )
        print(
            f"| {case} | {fmt_ns(t_nolto.get(a, []))} | {fmt_ns(t_lto.get(a, []))} "
            f"| {fmt_ns(t_lto.get(b, []))} | {b2} |"
        )
    print()
    print("B in the no-LTO binary (single-TU code, expected ≈ B with LTO):")
    for case, _, b in CASES:
        print(f"- {case}: {fmt_ns(t_nolto.get(b, []))}")
    print()

    print("## The falsifier's question: what does LTO refund?")
    print()
    print("tax = A(no LTO) − B; refund = A(no LTO) − A(LTO); residual = A(LTO) − B.")
    print("The residual is what only compiler-side knowledge can still remove.")
    print()
    print("| case | tax ns/op | refunded by LTO | residual ns/op | refunded % |")
    print("| --- | --- | --- | --- | --- |")
    for case, a, b in CASES:
        a0, a1, b1 = med(t_nolto.get(a, [])), med(t_lto.get(a, [])), med(
            t_lto.get(b, [])
        )
        tax, refund, residual = a0 - b1, a0 - a1, a1 - b1
        if tax < 1.0:
            print(f"| {case} | ≈0 (adapter already at parity) | — | — | — |")
        else:
            pct = 100.0 * refund / tax
            print(
                f"| {case} | {tax:.1f} | {refund:.1f} | {residual:.1f} "
                f"| {pct:.0f}% |"
            )
    print()

    print("## Dynamic JNI operations per iteration (interposed table, exact)")
    print()
    ops_of_interest = [
        "GetEnv",
        "GetVersion",
        "PushLocalFrame",
        "PopLocalFrame",
        "NewGlobalRef",
        "DeleteGlobalRef",
        "DeleteLocalRef",
        "ExceptionCheck",
    ]
    print("| kernel | " + " | ".join(ops_of_interest) + " |")
    print("| --- |" + " --- |" * len(ops_of_interest))
    _, c_lto, _ = runs["lto"]
    for kernel in KERNELS:
        if kernel not in c_lto:
            continue
        iters, ops = c_lto[kernel]
        cells = [f"{ops.get(op, 0) / iters:.3g}" for op in ops_of_interest]
        print(f"| {kernel} | " + " | ".join(cells) + " |")
    print()
    print("(Counts are identical between the two builds by construction; the")
    print("LTO build's are shown. The three original kernels additionally")
    print("perform their stated Java invocation/field operations; the env trio")
    print("performs only the two operations named by its rows.)")
    print()

    print("## Final assembly (call sites inside each kernel)")
    print()
    for tag in ("nolto", "lto"):
        print(f"### {tag}")
        print()
        for kernel in KERNELS:
            if kernel not in dis[tag]:
                print(f"- `{kernel}`: **symbol missing from disassembly**")
                continue
            n, calls = dis[tag][kernel]
            summary = ", ".join(
                f"{label}×{count}" for label, count in sorted(calls.items())
            )
            print(f"- `{kernel}` ({n} instructions): {summary or 'no calls'}")
        print()
    adapter_calls_lto = [
        label
        for kernel in KERNELS
        if kernel.startswith("a_") and kernel in dis["lto"]
        for label in dis["lto"][kernel][1]
        if label.startswith("nt_adp_")
    ]
    if adapter_calls_lto:
        print(
            "Adapter symbols still called under LTO (inlining did NOT fully"
            f" occur): {sorted(set(adapter_calls_lto))}"
        )
    else:
        print(
            "Under LTO no `nt_adp_*` call remains in any A kernel: the adapter"
            " translation units were fully inlined into their callers."
        )
    print()

    print("## Reading the result")
    print()
    print("- Operations reaching the JVM through the env table are opaque to")
    print("  LTO; it can never delete them. The refund column measures what it")
    print("  removes around them (shim frames, handle cells, destructor")
    print("  indirection). The residual column is the granularity tax itself —")
    print("  removable only by knowing escape and liveness, i.e. by the")
    print("  compiler.")
    print("- Absolute nanoseconds are HotSpot-on-this-host numbers. The")
    print("  structural finding (which operations remain in the final")
    print("  assembly) is VM-independent; magnitudes on ART will differ.")
    print("- Not measured: GC-root pressure from global references, contention")
    print("  on the global-ref lock under threads, weak-global upgrades.")


if __name__ == "__main__":
    main()
