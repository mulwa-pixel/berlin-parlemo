export function volatilityState(ticks) {
  let changes = 0;

  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i] !== ticks[i - 1]) changes++;
  }

  const ratio = changes / ticks.length;

  if (ratio < 0.4) return "LOW";
  if (ratio < 0.7) return "MEDIUM";
  return "HIGH";
}
