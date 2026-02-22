export function transitionMatrix(ticks) {
  const matrix = Array.from({ length: 10 }, () =>
    Array(10).fill(0)
  );

  for (let i = 0; i < ticks.length - 1; i++) {
    const current = Number(ticks[i].toString().slice(-1));
    const next = Number(ticks[i + 1].toString().slice(-1));

    matrix[current][next]++;
  }

  return matrix;
}
