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
  type gint,
} from "@native-typescript/gtk4";

if (!applicationStart()) throw new Error("the GTK target did not start");

const window = new Window();
window.setTitle("Native TypeScript");
window.setDefaultSize(720, 480);
window.setResizable(true);

const header = new HeaderBar();
header.setShowTitleButtons(false);
header.setTitleWidget(new Label("Widgets"));
header.packStart(new Image());
header.packEnd(new Button());

const content = new Box(Orientation.Vertical, 12);
content.setHomogeneous(false);
content.setMarginTop(8);
content.setMarginBottom(8);
content.setMarginStart(8);
content.setMarginEnd(8);
content.append(header);

const heading = new Label(null);
heading.setText("Native TypeScript");
heading.setWrap(true);
heading.setSelectable(false);
content.append(heading);

const entry = new Entry();
entry.maxLength = 32;
entry.setVisibility(true);
content.append(entry);

const controls = new Box(Orientation.Horizontal, 6);
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
  25,
  0,
  100,
  1,
  10,
  0,
);
adjustment.setStepIncrement(2);
const scale = new Scale(Orientation.Horizontal, adjustment);
scale.setDrawValue(true);
scale.setDigits(1);
const spin = new SpinButton(adjustment, 1, 0);
spin.setDigits(0);
content.append(scale);
content.append(spin);

const progress = new ProgressBar();
progress.fraction = 0.25;
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

let activatedRowIndex: gint | null = null;

/* A payload the handler never constructed: GTK hands the row over, the
 * dispatch references it so it survives a queued delivery, and the runtime
 * interns it so the handler is given the very cell built above. */
const rowActivated = list.onRowActivated((_sender, row): void => {
  activatedRowIndex = row.getIndex();
  /* Writing through the payload is what proves it is the row itself and not a
   * reading of it: the assertion below observes the change on the handle this
   * file constructed. */
  row.selectable = false;
});
if (!rowActivated.connected) throw new Error("row-activated did not connect");

const grid = new Grid();
grid.setRowSpacing(4);
grid.setColumnSpacing(8);
grid.attach(new Label("row"), 0, 0, 1, 1);
grid.attach(list, 1, 0, 1, 2);

/* An object goes in and four values come back. The input is borrowed for the
 * call: the grid already holds the child, and asking about it takes no
 * reference of its own. */
const listPlacement = grid.queryChild(list);

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
scroller.setMinContentHeight(120);
scroller.setMinContentWidth(240);
scroller.setChild(notes);
content.append(scroller);

const stack = new Stack();
content.append(stack);

window.setChild(content);
window.present();

/* Returns an optional number: the value crosses a union on the way out and
 * back, which is what any narrowing or absent value produces. */
function rowOffset(present: boolean): number | undefined {
  return present ? -7 : undefined;
}

let failure = "";

function check_(condition: boolean, description: string): void {
  if (!condition && failure.length === 0) failure = description;
}

function rejects(action: () => void): boolean {
  try {
    action();
  } catch (error) {
    return error instanceof TypeError;
  }
  return false;
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
  check_(entry.maxLength === 32, "the entry length limit is wrong");
  check_(entry.getTextLength() === 0, "the entry is not empty");
  check_(check.active, "the check button is not active");
  check_(toggle.active, "the toggle button is not active");
  check_(switch_.active, "the switch is not active");
  check_(progress.fraction === 0.25, "the progress fraction is wrong");
  check_(adjustment.value === 25, "the adjustment value is wrong");
  check_(adjustment.upper === 100, "the adjustment upper is wrong");
  check_(spin.value === 25, "the spin button did not share its adjustment");
  check_(scale.getValue() === 25, "the scale did not share its adjustment");
  check_(expander.expanded, "the expander is collapsed");
  check_(revealer.revealChild, "the revealer is hidden");
  check_(!notes.editable, "the text view is editable");
  check_(content.spacing === 12, "the box spacing is wrong");
  check_(window.visible, "the window is not visible");
  /* Objects this program never constructed. GTK owns them; the adapter takes a
   * reference so the handle can outlive whatever GTK does next, and the
   * runtime interns it so repeated reads name one managed cell.
   *
   * GIR says these can be absent, so absence is an answer rather than a throw.
   * The parent was constructed here, which means interning has to find its
   * existing cell — committing a second for one object traps. */
  const windowChild = window.getChild();
  check_(windowChild !== null, "the window forgot its child");
  const rowChild = alpha.getChild();
  check_(rowChild !== null, "the first row forgot its child");
  check_(new ListBoxRow().getChild() === null, "an empty row invented a child");
  const headingParent = heading.getParent();
  check_(headingParent !== null, "the heading lost its parent");
  check_(
    activatedRowIndex === 0,
    "the activated row arrived with the wrong index",
  );
  check_(!alpha.selectable, "the payload did not reach the original row");
  /* An enumeration crosses as an input, and the four measurements come back
   * as one value rather than four out-pointers. */
  const width = heading.measure(Orientation.Horizontal, -1);
  check_(
    width.minimum === 220,
    "the heading measured a width other than its request",
  );
  check_(
    listPlacement.column === 1 && listPlacement.row === 0 &&
      listPlacement.width === 1 && listPlacement.height === 2,
    "the grid reported the wrong placement for its child",
  );
  const requested = heading.getSizeRequest();
  check_(
    requested.width === 220 && requested.height === 40,
    "the size request did not come back through its output parameters",
  );
  /* GIR says a range always has one, so this reads as a plain Adjustment
   * rather than an optional — and it is the very adjustment constructed
   * above, which only interning can answer with. */
  check_(
    scale.getAdjustment().value === 25,
    "the scale's adjustment is not the one it was given",
  );
  check_(content.sensitive, "the content is not sensitive");
  check_(alpha.getIndex() === 0, "the first row reports the wrong index");
  check_(beta.getIndex() === 1, "the second row reports the wrong index");
  check_(gamma.getIndex() === 2, "the third row reports the wrong index");

  /* An optional number rides a union, which is what an absent value or a
   * narrowed one produces. A negative has to survive the slot it rides in. */
  check_(rowOffset(true) === -7, "a negative scalar lost its sign");
  check_(rowOffset(false) === undefined, "an absent scalar did not stay absent");
  const present = rowOffset(true);
  check_(present !== undefined, "a present scalar read as absent");
  check_(present !== 7, "a negative scalar read as its positive");
  /* A GLib integer is an ordinary number, so everything ordinary numbers do
   * works on one. None of the four lines below had an expression form while
   * these values were branded exact scalars: no ordering, no arithmetic
   * outside a construction, no formatting, and no standard library. */
  check_(width.minimum > 100, "a measured width would not compare");
  check_(content.spacing + 1 === 13, "a spacing would not add");
  check_(
    Math.max(requested.width, requested.height) === 220,
    "the standard library would not take a GLib integer",
  );
  check_(`${alpha.getIndex()}` === "0", "a row index would not print");
  /* A gdouble is a double in both worlds, so it crosses as itself: the
   * projection converts nothing, and the value divides and orders like the
   * number it is. */
  check_(adjustment.value / 5 === 5, "an adjustment value would not divide");
  check_(progress.fraction < 1, "a fraction would not compare");
  check_(scale.getValue() + 0.5 === 25.5, "a scale value would not add");

  /* The boundary check is what keeps that honesty affordable. Each value below
   * has no `gint` or `guint` to convert to, so the call throws a TypeError the
   * program catches, and the widget keeps what it had. Every one is computed:
   * a literal the compiler can disprove is refused where it is written rather
   * than deferred to a throw. */
  const limit = entry.maxLength;
  const zero = limit - limit;
  check_(
    rejects((): void => {
      entry.maxLength = limit + 0.5;
    }),
    "a fraction crossed the boundary",
  );
  check_(
    rejects((): void => {
      entry.maxLength = limit + 2147483647;
    }),
    "a value above gint crossed the boundary",
  );
  check_(
    rejects((): void => {
      entry.maxLength = zero / zero;
    }),
    "NaN crossed the boundary",
  );
  check_(
    rejects((): void => {
      grid.setRowSpacing(-limit);
    }),
    "a negative crossed into an unsigned slot",
  );
  check_(entry.maxLength === 32, "a refused conversion changed the widget");

  console.log(failure.length > 0 ? failure : "widgets ok");
  window.destroy();
  applicationQuit();
});
if (!clicked.connected) throw new Error("clicked did not connect");

/* Two values come back from one call, through output parameters the adapter
 * turns into a struct. Nothing about the C signature reaches TypeScript: the
 * pointers are the adapter's business, and this reads as a record. */
heading.setSizeRequest(220, 40);

/* A deprecated member still binds. GTK would rather this were
 * `setVisible(true)`, and the generated declaration says so, but an
 * application migrating off one has to be able to call it meanwhile. */
heading.show();

/* Emits row-activated, whose payload is the row itself. */
alpha.activate();

if (!action.activate()) {
  clearTimeout(deadline);
  console.log("the button refused activation");
  applicationQuit();
}
