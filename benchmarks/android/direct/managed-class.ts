/** A Java-resident managed object workload shared by the legacy exported
 * kernel and the compiler-emitted Activity. Keeping it separate prevents the
 * Activity plan from rooting callback bridges and Android handles that belong
 * to later direct-JVM slices. */
class ManagedCounterBase {
  protected value = 7;

  step(): number {
    this.value = ((this.value << 5) ^ (this.value >>> 2) ^ 17) & 1023;
    return this.value;
  }
}

class ManagedCounter extends ManagedCounterBase {
  private bonus = 1;

  override step(): number {
    return super.step() + this.bonus;
  }
}

export function runManagedClassWorkload(iterations: number): number {
  const counter: ManagedCounterBase = new ManagedCounter();
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    checksum += counter.step();
    index += 1;
  }
  return checksum;
}
