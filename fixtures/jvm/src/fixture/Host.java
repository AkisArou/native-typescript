package fixture;

/**
 * The subclass-generation fixture: a base whose overridable method is called
 * VIRTUALLY by its own "framework" loop, so a generated subclass's native
 * override — implemented in TypeScript — steers control flow the base wrote.
 * The Android analogue is an Activity whose lifecycle the framework drives.
 */
public class Host {
  /** Overridable; the base answers false, so accepted counts prove the
   * override ran rather than the base. */
  public boolean onEvent(int value) {
    return false;
  }

  public int run(int count) {
    int accepted = 0;
    for (int i = 0; i < count; i++) {
      if (onEvent(i)) accepted++;
    }
    return accepted;
  }

  /** Refusal fixtures: a final method cannot be overridden, and a void
   * method waits on the void-synchronous arm. */
  public final int sealed() {
    return 1;
  }

  public void onNotify(int value) {}

  /** The payload-carrying overridable: ANSWERS while holding a scalar and
   * an object — the intersection no fixture had inhabited (answered
   * synchronous × handle payload; the onKeyDown shape). The base ignores
   * the payload and answers false, so an accepted count proves the
   * override read the object it was handed rather than the base running. */
  public boolean onMeasure(int bias, Widget subject) {
    return false;
  }

  /** The framework loop for onMeasure: dispatches virtually with its own
   * payload and counts acceptances in the caller's frame. */
  public int survey(Widget subject, int count) {
    int accepted = 0;
    for (int i = 0; i < count; i++) {
      if (onMeasure(i, subject)) accepted++;
    }
    return accepted;
  }
}
