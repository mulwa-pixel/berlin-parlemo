export function stakeSizing(balance, confidence) {
  const baseRisk = 0.01; // 1%

  const multiplier = confidence / 100;

  return balance * baseRisk * multiplier;
}
