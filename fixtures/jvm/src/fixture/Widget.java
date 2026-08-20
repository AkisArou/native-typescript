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

  public static byte[] nullBytes() {
    return null;
  }

  public static String[] splitWords(String text) {
    return text.split(" ");
  }

  public static String[] emptyWords() {
    return new String[0];
  }

  public static String[] nullElement() {
    return new String[] {"a", null};
  }

  public static int countTags(String[] tags) {
    return tags.length;
  }

  public static String joinWords(String[] words) {
    return String.join(",", words);
  }

  public static double[] samples() {
    return new double[] {0.5};
  }

  public static long[] ids() {
    return new long[] {1L};
  }

  public static int sumInts(int[] values) {
    int total = 0;
    for (int v : values) total += v;
    return total;
  }

  public static int countInts(int[] values) {
    return values.length;
  }

  public static float[] reverseFloats(float[] values) {
    float[] out = new float[values.length];
    for (int i = 0; i < values.length; i++) out[values.length - 1 - i] = values[i];
    return out;
  }

  /** The inward direction: TypeScript provides this implementation. */
  public native boolean onPing(int value);

  public int ping(int count) {
    int accepted = 0;
    for (int i = 0; i < count; i++) {
      if (onPing(i)) accepted++;
    }
    return accepted;
  }

  /** The queued inward direction: answers nothing, delivered at the pump. */
  public native void onTick(int value);

  public void tick(int count) {
    for (int i = 0; i < count; i++) {
      onTick(i);
    }
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
