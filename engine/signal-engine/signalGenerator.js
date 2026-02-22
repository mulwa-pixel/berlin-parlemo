export function generateSignal(scoreObj) {
  if (scoreObj.score > 18) {
    return {
      action: "TRADE",
      digit: scoreObj.digit,
      confidence: scoreObj.score
    };
  }

  return { action: "WAIT" };
}
