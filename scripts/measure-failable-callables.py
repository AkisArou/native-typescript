"""Failable callables in the installed GIRs, bucketed by what their own result
carries.

This is the measurement behind investigation record 0005. It lives here rather
than in the record so the table can be re-derived instead of trusted: an SDK
upgrade moves these numbers, and a number nobody can reproduce is not evidence.

The rule: <method> and <constructor> children of a <class> or <interface>
carrying throws="1" and not introspectable="0". That is the surface this
project can reach — a GIR snapshot holds constructors, methods and signals, so
a namespace-level <function> is outside the algebra for reasons that have
nothing to do with failure and would inflate the count.
"""
import xml.etree.ElementTree as ET, collections, sys
G = "{http://www.gtk.org/introspection/core/1.0}"
NUMERIC = {"gint","guint","gint8","guint8","gint16","guint16","gint32","guint32",
           "gint64","guint64","gsize","gssize","gunichar","gdouble","gfloat"}
def bucket(m):
    rv = m.find(f"{G}return-value")
    ty = rv.find(f"{G}type") if rv is not None else None
    if ty is None:
        return "array or other" if rv is not None else "flag: void"
    name, transfer = ty.get("name"), rv.get("transfer-ownership")
    if name == "none": return "flag: void"
    if name == "gboolean": return "flag: gboolean"
    if name in NUMERIC: return "numeric scalar"
    if name == "utf8": return "utf8 string"
    return f"object ({transfer})"
rows = {}
for ns in ("Gtk-4.0", "Gio-2.0", "GLib-2.0"):
    root = ET.parse(f"/usr/share/gir-1.0/{ns}.gir").getroot()
    counts = collections.Counter()
    for holder in list(root.iter(f"{G}class")) + list(root.iter(f"{G}interface")):
        for kind in ("method", "constructor"):
            for m in holder.findall(f"{G}{kind}"):
                if m.get("throws") != "1" or m.get("introspectable") == "0":
                    continue
                counts[bucket(m)] += 1
    rows[ns] = counts
keys = sorted({k for c in rows.values() for k in c})
width = max(len(k) for k in keys) + 2
print(f"{'':{width}}" + "".join(f"{ns:>10}" for ns in rows) + f"{'total':>8}")
for k in keys:
    print(f"{k:{width}}" + "".join(f"{rows[ns][k]:>10}" for ns in rows) +
          f"{sum(rows[ns][k] for ns in rows):>8}")
print(f"{'TOTAL':{width}}" + "".join(f"{sum(rows[ns].values()):>10}" for ns in rows) +
      f"{sum(sum(c.values()) for c in rows.values()):>8}")
