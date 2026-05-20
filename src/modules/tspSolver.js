/**
 * Pure TSP solver — Nearest Neighbor construction + 2-Opt + Or-Opt improvement.
 * No external dependencies; operates on an NxN distance matrix.
 */

/**
 * Solve TSP with fixed-point constraints.
 * @param {Object} opts
 * @param {number[][]} opts.distanceMatrix - NxN symmetric distance matrix
 * @param {number} opts.startIdx - index of depot start in the matrix
 * @param {number} opts.endIdx - index of depot end in the matrix
 * @param {number[]} [opts.fixedIndices] - indices that must keep their position in the tour
 * @param {number} [opts.maxIterations] - max 2-opt improvement iterations (default 100)
 * @returns {{ tour: number[], totalDistance: number }}
 */
function solve({ distanceMatrix, startIdx, endIdx, fixedIndices = [], maxIterations = 100 }) {
  const n = distanceMatrix.length;
  if (n <= 2) return { tour: Array.from({ length: n }, (_, i) => i), totalDistance: 0 };

  const fixedSet = new Set(fixedIndices);
  const stopIndices = [];
  for (let i = 0; i < n; i++) {
    if (i !== startIdx && i !== endIdx) stopIndices.push(i);
  }

  if (stopIndices.length === 0) {
    const d = distanceMatrix[startIdx]?.[endIdx] || 0;
    return { tour: startIdx === endIdx ? [startIdx] : [startIdx, endIdx], totalDistance: d };
  }

  let tour = nearestNeighbor(distanceMatrix, startIdx, endIdx, stopIndices);
  tour = twoOpt(distanceMatrix, tour, fixedSet, startIdx, endIdx, maxIterations);
  tour = orOpt(distanceMatrix, tour, fixedSet, startIdx, endIdx);

  const totalDistance = tourDistance(distanceMatrix, tour);
  return { tour, totalDistance };
}

/**
 * Phase 1: Nearest Neighbor — greedy construction heuristic.
 * Builds a tour starting from startIdx, greedily visiting the nearest unvisited stop.
 */
function nearestNeighbor(matrix, startIdx, endIdx, stopIndices) {
  const unvisited = new Set(stopIndices);
  const tour = [startIdx];
  let current = startIdx;

  while (unvisited.size > 0) {
    let nearest = -1;
    let nearestDist = Infinity;
    for (const idx of unvisited) {
      const d = matrix[current][idx];
      if (d < nearestDist) {
        nearestDist = d;
        nearest = idx;
      }
    }
    tour.push(nearest);
    unvisited.delete(nearest);
    current = nearest;
  }

  if (endIdx !== startIdx) tour.push(endIdx);
  return tour;
}

/**
 * Phase 2: 2-Opt improvement — iteratively reverse sub-segments to reduce total distance.
 * Skips reversals that would move fixed-position stops.
 */
function twoOpt(matrix, tour, fixedSet, startIdx, endIdx, maxIterations) {
  let best = tour.slice();
  let bestDist = tourDistance(matrix, best);
  let improved = true;
  let iterations = 0;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    // Inner stops are indices 1..len-2 (skip start at 0, end at len-1)
    const innerStart = 1;
    const innerEnd = best.length - (endIdx !== startIdx ? 2 : 1);

    for (let i = innerStart; i <= innerEnd; i++) {
      for (let j = i + 1; j <= innerEnd + 1 && j < best.length; j++) {
        if (wouldMoveFixed(best, i, j, fixedSet)) continue;

        const newTour = twoOptSwap(best, i, j);
        const newDist = tourDistance(matrix, newTour);
        if (newDist < bestDist - 1e-10) {
          best = newTour;
          bestDist = newDist;
          improved = true;
        }
      }
    }
  }

  return best;
}

/** Reverse the segment between indices i and j in the tour. */
function twoOptSwap(tour, i, j) {
  const newTour = tour.slice(0, i);
  for (let k = j; k >= i; k--) newTour.push(tour[k]);
  for (let k = j + 1; k < tour.length; k++) newTour.push(tour[k]);
  return newTour;
}

/**
 * Phase 3: Or-Opt — relocate single stops or pairs to better positions.
 * Tries moving 1, 2, or 3 consecutive stops to every other valid position.
 */
function orOpt(matrix, tour, fixedSet, startIdx, endIdx) {
  let best = tour.slice();
  let bestDist = tourDistance(matrix, best);
  let improved = true;

  while (improved) {
    improved = false;
    for (let segLen = 1; segLen <= 3; segLen++) {
      for (let i = 1; i < best.length - segLen; i++) {
        const segEnd = i + segLen - 1;
        if (endIdx !== startIdx && segEnd >= best.length - 1) continue;

        const segment = best.slice(i, segEnd + 1);
        if (segment.some((idx) => fixedSet.has(idx))) continue;

        for (let j = 1; j < best.length; j++) {
          if (j >= i && j <= segEnd + 1) continue;
          if (endIdx !== startIdx && j >= best.length) continue;

          const candidate = [];
          for (let k = 0; k < best.length; k++) {
            if (k === i) { k = segEnd; continue; }
            if (candidate.length === j && !candidate.includes(segment[0])) {
              candidate.push(...segment);
            }
            candidate.push(best[k]);
          }
          if (!candidate.includes(segment[0])) candidate.splice(j, 0, ...segment);

          if (candidate.length !== best.length) continue;

          const candidateDist = tourDistance(matrix, candidate);
          if (candidateDist < bestDist - 1e-10) {
            best = candidate;
            bestDist = candidateDist;
            improved = true;
          }
        }
      }
    }
  }

  return best;
}

/** Check if reversing segment [i..j] would relocate any fixed-position stop. */
function wouldMoveFixed(tour, i, j, fixedSet) {
  for (let k = i; k <= j; k++) {
    if (fixedSet.has(tour[k])) return true;
  }
  return false;
}

/** Calculate total distance of a tour given a distance matrix. */
function tourDistance(matrix, tour) {
  let total = 0;
  for (let i = 1; i < tour.length; i++) {
    total += matrix[tour[i - 1]][tour[i]];
  }
  return total;
}

module.exports = { solve, nearestNeighbor, twoOpt, orOpt, tourDistance };
