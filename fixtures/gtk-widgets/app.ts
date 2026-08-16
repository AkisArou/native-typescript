/* A GTK application built from a realistic widget surface.
 *
 * Twenty-eight classes, their constructors, properties, methods and one
 * signal, all generated from GIR. The point is breadth: every widget here is
 * constructed, wired into a real window, and then read back, so a member that
 * stopped projecting — or projected but returned the wrong value — fails this
 * program rather than being discovered by whoever tried to use it.
 *
 * Nothing here is hand-written C, and nothing is a mock. */

import {
  applicationQuit,
  applicationStart,
} from "@native-typescript/gtk-application";
import {
  Adjustment,
  Box,
  Button,
  CheckButton,
  Entry,
  Expander,
  Frame,
  Grid,
  HeaderBar,
  Image,
  Label,
  ListBox,
  ListBoxRow,
  Orientation,
  ProgressBar,
  Revealer,
  Scale,
  ScrolledWindow,
  Separator,
  SpinButton,
  Stack,
  Switch,
  TextView,
  ToggleButton,
  Window,
  type gdouble,
  type gint,
  type guint,
  type guint16,
} from "@native-typescript/gtk4";

if (!applicationStart()) throw new Error("the GTK target did not start");

const window = new Window();
window.setTitle("Native TypeScript");
window.setDefaultSize(720 as gint, 480 as gint);
window.setResizable(true);

const header = new HeaderBar();
header.setShowTitleButtons(false);
header.setTitleWidget(new Label("Widgets"));
header.packStart(new Image());
header.packEnd(new Button());

const content = new Box(Orientation.Vertical, 12 as gint);
content.setHomogeneous(false);
content.setMarginTop(8 as gint);
content.setMarginBottom(8 as gint);
content.setMarginStart(8 as gint);
content.setMarginEnd(8 as gint);
content.append(header);

const heading = new Label(null);
heading.setText("Native TypeScript");
heading.setWrap(true);
heading.setSelectable(false);
content.append(heading);

const entry = new Entry();
entry.maxLength = 32 as gint;
entry.setVisibility(true);
content.append(entry);

const controls = new Box(Orientation.Horizontal, 6 as gint);
const check = CheckButton.withLabel("Enabled");
check.active = true;
const toggle = new ToggleButton();
toggle.active = true;
const switch_ = new Switch();
switch_.active = true;
const action = Button.withLabel("Run");
action.setHasFrame(true);
controls.append(check);
controls.append(toggle);
controls.append(switch_);
controls.append(action);
content.append(controls);
content.append(new Separator(Orientation.Horizontal));

const adjustment = new Adjustment(
  25 as gdouble,
  0 as gdouble,
  100 as gdouble,
  1 as gdouble,
  10 as gdouble,
  0 as gdouble,
);
adjustment.setStepIncrement(2 as gdouble);
const scale = new Scale(Orientation.Horizontal, adjustment);
scale.setDrawValue(true);
scale.setDigits(1 as gint);
const spin = new SpinButton(adjustment, 1 as gdouble, 0 as guint);
spin.setDigits(0 as guint);
content.append(scale);
content.append(spin);

const progress = new ProgressBar();
progress.fraction = 0.25 as gdouble;
progress.setText("Quarter");
content.append(progress);

const list = new ListBox();
list.setShowSeparators(true);

/* Named rather than collected in an array: indexing one would produce
 * `ListBoxRow | undefined`, and a union carrying an exact native scalar has no
 * representation in the emitted C yet. */
function listRow(caption: string): ListBoxRow {
  const row = new ListBoxRow();
  row.setActivatable(true);
  row.setChild(new Label(caption));
  list.append(row);
  return row;
}

const alpha = listRow("alpha");
const beta = listRow("beta");
const gamma = listRow("gamma");

const grid = new Grid();
grid.setRowSpacing(4 as guint);
grid.setColumnSpacing(8 as guint);
grid.attach(new Label("row"), 0 as gint, 0 as gint, 1 as gint, 1 as gint);
grid.attach(list, 1 as gint, 0 as gint, 1 as gint, 2 as gint);

const frame = new Frame("Items");
frame.setChild(grid);

const revealer = new Revealer();
revealer.setChild(frame);
revealer.revealChild = true;

const expander = new Expander("Details");
expander.setChild(revealer);
expander.expanded = true;
content.append(expander);

const notes = new TextView();
notes.editable = false;
notes.setMonospace(true);
const scroller = new ScrolledWindow();
scroller.setMinContentHeight(120 as gint);
scroller.setMinContentWidth(240 as gint);
scroller.setChild(notes);
content.append(scroller);

const stack = new Stack();
content.append(stack);

window.setChild(content);
window.present();

/* Returns an optional exact scalar: the value crosses a union on the way out
 * and back, which is what any narrowing or absent value produces. */
function rowIndex(present: boolean): gint | undefined {
  return present ? (-7 as gint) : undefined;
}

let failure = "";

function check_(condition: boolean, description: string): void {
  if (!condition && failure.length === 0) failure = description;
}

/* Declared before the handler because the handler must cancel it: a pending
 * timer keeps the runtime turning, so leaving it armed would hold the process
 * open for its full duration after the work is done. */
const deadline = setTimeout((): void => {
  console.log("the button was never activated");
  applicationQuit();
}, 10_000);

const clicked = action.onClicked((sender): void => {
  clearTimeout(deadline);
  /* Button's label can be absent, so it reads as a call; Label's cannot, so it
   * stays a property. The split is the point: a property claims a stability
   * only a non-nullable read has. */
  check_(sender.getLabel() === "Run", "the button forgot its label");
  check_(heading.getText() === "Native TypeScript", "the heading text is wrong");
  check_(heading.label === "Native TypeScript", "the heading label is wrong");
  check_(entry.maxLength === (32 as gint), "the entry length limit is wrong");
  check_(entry.getTextLength() === (0 as guint16), "the entry is not empty");
  check_(check.active, "the check button is not active");
  check_(toggle.active, "the toggle button is not active");
  check_(switch_.active, "the switch is not active");
  check_(progress.fraction === (0.25 as gdouble), "the progress fraction is wrong");
  check_(adjustment.value === (25 as gdouble), "the adjustment value is wrong");
  check_(adjustment.upper === (100 as gdouble), "the adjustment upper is wrong");
  check_(spin.value === (25 as gdouble), "the spin button did not share its adjustment");
  check_(scale.getValue() === (25 as gdouble), "the scale did not share its adjustment");
  check_(expander.expanded, "the expander is collapsed");
  check_(revealer.revealChild, "the revealer is hidden");
  check_(!notes.editable, "the text view is editable");
  check_(content.spacing === (12 as gint), "the box spacing is wrong");
  check_(window.visible, "the window is not visible");
  /* Objects this program never constructed. GTK owns them; the adapter takes a
   * reference so the handle can outlive whatever GTK does next, and the
   * runtime interns it so repeated reads name one managed cell.
   *
   * A container with no child throws rather than answering null, because a
   * nullable owned handle lowers as an error — the same rule a nullable
   * constructor result follows. */
  window.getChild().visible = true;
  alpha.getChild().visible = true;
  /* The parent is an object this program constructed, so its pointer already
   * has a managed cell. Interning has to find it: committing a second cell for
   * one object traps rather than leaving two to disagree. */
  heading.getParent().visible = true;
  let absentReported = false;
  try {
    new ListBoxRow().getChild();
  } catch {
    absentReported = true;
  }
  check_(absentReported, "an empty row invented a child");
  check_(content.sensitive, "the content is not sensitive");
  /* An exact native scalar is constructed from a literal, never from an
   * arbitrary number: the compiler has to prove the value is in range. */
  check_(alpha.getIndex() === (0 as gint), "the first row reports the wrong index");
  check_(beta.getIndex() === (1 as gint), "the second row reports the wrong index");
  check_(gamma.getIndex() === (2 as gint), "the third row reports the wrong index");

  /* An optional exact scalar rides a union, which is what an absent value or
   * a narrowed one produces. A negative has to survive the slot it rides in. */
  check_(rowIndex(true) === (-7 as gint), "a negative scalar lost its sign");
  check_(rowIndex(false) === undefined, "an absent scalar did not stay absent");
  const present = rowIndex(true);
  check_(present !== undefined, "a present scalar read as absent");
  check_(present !== (7 as gint), "a negative scalar read as its positive");
  console.log(failure.length > 0 ? failure : "widgets ok");
  window.destroy();
  applicationQuit();
});
if (!clicked.connected) throw new Error("clicked did not connect");

if (!action.activate()) {
  clearTimeout(deadline);
  console.log("the button refused activation");
  applicationQuit();
}
