export function digitFrequency(ticks) {
  const freq = Array(10).fill(0);

  ticks.forEach(t => {
    const digit = Number(t.toString().slice(-1));
    freq[digit]++;
  });

  const total = ticks.length;

  return freq.map(count => count / total);
}
