import {
  Button,
  LinearLayout,
  TextView,
  type Activity,
} from "@native-typescript/jvm-android_benchmark";

/** Build the same nested Android view graph as the Kotlin control. This is
 * deliberately imperative: it measures direct API construction, setters,
 * dynamic strings, and hierarchy ownership rather than a renderer. */
export function runScreenBuildWorkload(
  activity: Activity,
  rows: number,
): number {
  const screen = new LinearLayout(activity);
  screen.setOrientation(LinearLayout.VERTICAL);
  let checksum = 0;
  let index = 0;
  while (index < rows) {
    const row = new LinearLayout(activity);
    row.setOrientation(LinearLayout.HORIZONTAL);
    const title = new TextView(activity);
    const titleText = `Item ${index}`;
    title.setText(titleText);
    title.setMinimumHeight(48 + (index & 1));
    const action = new Button(activity);
    const actionText = `Open ${index}`;
    action.setText(actionText);
    row.addView(title);
    row.addView(action);
    screen.addView(row);
    checksum += titleText.length + actionText.length;
    index += 1;
  }
  return checksum;
}
