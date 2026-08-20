package fixture;

/**
 * The void-synchronous arm's failing program, committed before the arm
 * exists so the eventual proposal arrives with its evidence in the tree.
 *
 * {@code onCreate} is void and MUST complete before the framework
 * continues: {@code start} calls it and then immediately observes its
 * effect. A queued delivery would return 0 — the handler not yet run — so
 * this fixture distinguishes synchronous from queued BY CONSTRUCTION, the
 * same way reverseBytes distinguishes right-bytes-wrong-place and
 * countInts distinguishes elements from bytes. The three questions the
 * arm must answer, recorded where its evidence lives: a void result in
 * the answered position; handle payloads (a real onCreate receives a
 * Bundle); and where a synchronous void handler's THROW goes, since there
 * is no answer to carry the failure and no queue to drain it into.
 */
public class Lifecycle {
  private boolean created;

  /** Overridable, void, and observed synchronously by the framework. */
  public void onCreate() {}

  /** What an override calls to have a synchronously visible effect. */
  protected final void markCreated() {
    created = true;
  }

  /** The framework: dispatches the lifecycle method, then observes it. */
  public final int start() {
    onCreate();
    return created ? 1 : 0;
  }
}
