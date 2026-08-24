/** Parse a bounded mix of integer, fractional, signed, and exponent text.
 * Values are selected outside the parser rather than generated in the timed
 * loop, and every binary fraction is scaled exactly so the checksum adds no
 * formatting or rounding policy of its own. */
export function runNumberParsingWorkload(iterations: number): number {
  const integerInputs = [
    "0", "7", "42", "-17", "255", "1024", "6553", "-3276",
    "12345", "-7654", "2147", "-9999", "73", "8080", "-4096", "3141",
  ];
  const floatInputs = [
    "0.5", "-2.25", "3.125", "1e3", "-0.03125", "42.75", "512.5", "-128.125",
    "0.125", "64.875", "-16.5", "2048.25", "-4096.75", "7.5", "0e0", "123.375",
  ];
  const numberInputs = [
    "1.25", "-3.5", "6.125", "2.5e2", "-0.0625", "18.75", "256.25", "-64.5",
    "0.375", "32.625", "-8.25", "1024.5", "-2048.125", "15.875", "0.0", "61.25",
  ];
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    const slot = index & 15;
    checksum += parseInt(integerInputs[slot]!, 10);
    checksum += parseFloat(floatInputs[slot]!) * 32;
    checksum += Number(numberInputs[slot]!) * 32;
    index += 1;
  }
  return checksum;
}
