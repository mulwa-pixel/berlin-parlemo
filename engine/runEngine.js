import { digitFrequency } from "./probability-core/digitFrequency.js";
import { volatilityState } from "./probability-core/volatilityState.js";
import { transitionMatrix } from "./probability-core/transitionMatrix.js";
import { probabilityScore } from "./probability-core/probabilityScore.js";
import { confluenceScore } from "./signal-engine/confluenceScore.js";
import { generateSignal } from "./signal-engine/signalGenerator.js";

export function runEngine(ticks) {
  const freq = digitFrequency(ticks);
  const vol = volatilityState(ticks);
  const matrix = transitionMatrix(ticks);

  const lastDigit = Number(ticks[ticks.length - 1].toString().slice(-1));

  const probs = probabilityScore(freq, matrix, lastDigit, vol);

  const score = confluenceScore(probs);

  return generateSignal(score);
}
