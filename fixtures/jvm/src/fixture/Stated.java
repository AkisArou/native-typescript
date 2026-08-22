package fixture;

import android.annotation.NonNull;
import android.annotation.Nullable;

/**
 * Every arm of the nullability algebra, in one class file.
 *
 * A class file states nullability through annotations, which are a CLAIM by
 * the library rather than anything the JVM enforces. That is enough to
 * narrow a slot the CALLER fills — the narrowed type becomes the thing that
 * stops a null from being written — and not enough on its own to narrow a
 * slot the PLATFORM fills, which is why a non-null result is checked in the
 * generated adapter. This fixture exists so both halves of that asymmetry
 * have a program that would notice if either changed.
 */
public class Stated {
  public Stated() {}

  /** Non-null on both sides: the narrowest surface either can have. */
  @NonNull
  public String echo(@NonNull String value) {
    return value;
  }

  /** Stated absent. Same slot as an unannotated one, said out loud. */
  @Nullable
  public String maybe(@Nullable String value) {
    return value;
  }

  /** States nothing, which is overwhelmingly the common case. */
  public String silent(String value) {
    return value;
  }

  /** A handle position, so the narrowing is not a string-only accident. */
  @NonNull
  public Stated self(@NonNull Stated other) {
    return other;
  }

  /**
   * Both at once. This is a contradiction in the class file rather than a
   * case to resolve: choosing a side would be ingestion deciding what the
   * library meant, so it reads as stating nothing.
   */
  @NonNull
  @Nullable
  public String confused() {
    return "";
  }

  /** A primitive carrying the annotation anyway. Nullability is not a
   * property this slot has, and an int does not become interesting because
   * something was written above it. */
  @NonNull
  public int counted(@NonNull int value) {
    return value;
  }
}
