// The Java side of the adapter-plus-LTO falsifier. Deliberately tiny: the
// instrument measures the native boundary, so the Java methods must be cheap
// and JIT-stable, contributing the same cost to every variant.
final class NTFalsifier {
  static final class Widget {
    final int value;

    Widget(int value) {
      this.value = value;
    }
  }

  // Allocates one object per call: the returned local reference is the thing
  // whose lifetime the two variants manage differently.
  static Widget make(int seed) {
    return new Widget(seed * 0x9E3779B9 + 1);
  }

  // A useful primitive result with a real failure channel: throws
  // ArithmeticException("integer overflow") on overflow.
  static int checkedAdd(int a, int b) {
    return Math.addExact(a, b);
  }

  private NTFalsifier() {}
}
