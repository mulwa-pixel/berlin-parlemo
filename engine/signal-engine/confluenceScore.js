export function confluenceScore(probabilities) {
  const maxProb = Math.max(...probabilities);
  const digit = probabilities.indexOf(maxProb);

  const score = maxProb * 100;

  return {
    digit,
    score
  };
}
