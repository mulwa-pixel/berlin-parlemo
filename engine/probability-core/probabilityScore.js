export function probabilityScore(freq, matrix, lastDigit, volatility) {
  const transitionRow = matrix[lastDigit];
  const totalTransitions = transitionRow.reduce((a, b) => a + b, 0);

  const transitionProb = transitionRow.map(v =>
    totalTransitions ? v / totalTransitions : 0
  );

  const combined = freq.map((f, i) => (f * 0.6) + (transitionProb[i] * 0.4));

  let volatilityWeight = 1;

  if (volatility === "HIGH") volatilityWeight = 0.8;
  if (volatility === "LOW") volatilityWeight = 1.2;

  return combined.map(p => p * volatilityWeight);
}
