package fixture;

/**
 * Ingestion fixture. Every member exists to exercise one arm of the class-file
 * algebra: overloads force descriptor-qualified selection, the constants carry
 * every ConstantValue kind, {@code acquire} declares a checked exception,
 * {@code generic} carries a Signature attribute, {@code nativeHandle} carries
 * ACC_NATIVE, and the two nested classes split the static-nested (in the
 * algebra) from the inner (outside it, its constructor takes an outer
 * instance) cases.
 *
 * The compiled bytes beside this source are committed; tests pin their
 * digests. Recompiling (javac -d ../classes fixture/*.java) changes digests
 * and is a deliberate fixture bump.
 */
public class Widget {
  public static final int MAX_DEPTH = 32;
  public static final long SEED = 0x9E3779B97F4A7C15L;
  public static final float SCALE = 1.5f;
  public static final double RATIO = 0.25d;
  public static final String NAME = "widget";

  protected int depth;

  public Widget() {}

  public Widget(int depth) {
    this.depth = depth;
  }

  public int depth() {
    return depth;
  }

  public static int checkedAdd(int a, int b) {
    return Math.addExact(a, b);
  }

  public Widget resized(int depth) {
    return new Widget(depth);
  }

  public int compareDepth(Widget other) {
    return other == null ? -1 : Integer.compare(depth, other.depth);
  }

  public String label(int n) {
    return "widget-" + n;
  }

  public static String greet(String name) {
    return name == null ? null : "hi " + name + "!";
  }

  public static String withNul() {
    return "a\u0000b";
  }

  public static int nameLength(String name) {
    return name == null ? -1 : name.length();
  }

  public static int sumBytes(byte[] data) {
    int total = 0;
    for (byte b : data) total += b & 0xFF;
    return total;
  }

  public static byte[] reverseBytes(byte[] data) {
    byte[] out = new byte[data.length];
    for (int i = 0; i < data.length; i++) out[data.length - 1 - i] = data[i];
    return out;
  }

  public void resize(int width, int height) {}

  public void resize(double scale) {}

  public int[] measure(String label, boolean tight) {
    return new int[] {label.length(), tight ? 1 : 0};
  }

  public static Widget acquire() throws java.io.IOException {
    return new Widget();
  }

  @Deprecated
  public void legacy() {}

  public <T> T generic(T value) {
    return value;
  }

  public native long nativeHandle();

  public static class Metrics {
    public int width;
    public int height;
  }

  public class Painter {}
}
