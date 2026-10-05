import type {
  Board,
  EnumerationResult,
  MoveDetail,
  PathResult,
  Points,
  UnusedDie,
} from "./types.ts";
import { applyMove, boardFromPoints, legalMovesForDie, onBoardCount } from "./rules.ts";

/**
 * 根据两个骰点生成本回合的“可用骰点序列”。
 * 不同骰点：两颗各用一次（顺序由搜索自由决定）。
 * 相同骰点（双骰）：四次同值移动机会。
 */
export function dieSlots(d1: number, d2: number): number[] {
  return d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
}

function unusedReason(board: Board, d: number): UnusedDie {
  if (onBoardCount(board.points) === 0) return { d, reason: "no_checkers" };
  return { d, reason: "no_legal_move" };
}

/** 由骰子序列计算未使用骰点（路径终止后剩余的槽位）。 */
function collectUnused(end: Board, remaining: number[]): UnusedDie[] {
  const result: UnusedDie[] = [];
  const seen = new Set<number>();
  for (const d of remaining) {
    if (seen.has(d)) continue;
    seen.add(d);
    result.push(unusedReason(end, d));
  }
  return result;
}

interface SearchState {
  board: Board;
  remaining: number[];
  moves: MoveDetail[];
}

/**
 * 枚举所有合法完整路径，随后：
 *  1. 仅保留用骰次数最多者；
 *  2. 受限大骰优先：两个不同骰点且较大骰点在初始盘面存在合法走法时，
 *     无论路径是否提前离盘完毕，一律只保留首步使用较大骰点的路径。
 *
 * 预算按状态节点展开数计量；预算不足时 complete=false，
 * 不凭截短结果拒绝任何未出现的路径，也不宣称已找全。
 */
export function enumeratePaths(
  initial: Board,
  d1: number,
  d2: number,
  budget: number,
): EnumerationResult {
  const slots = dieSlots(d1, d2);
  const distinct = d1 !== d2;
  const larger = Math.max(d1, d2);
  const smaller = Math.min(d1, d2);
  // 大骰优先是否生效：较大骰点在初盘确实有合法走法。
  const largerUsableAtRoot = legalMovesForDie(initial.points, larger).length > 0;

  const collected: PathResult[] = [];
  const dedup = new Set<string>();
  let nodes = 0;
  let truncated = false;

  const stack: SearchState[] = [{ board: initial, remaining: slots, moves: [] }];

  while (stack.length > 0) {
    const state = stack.pop()!;
    nodes += 1;
    if (nodes > budget) {
      truncated = true;
      break;
    }

    const { board, remaining, moves } = state;

    // 枚举当前所有合法的“下一步”（来源点互异，自动去除棋子身份重复）。
    const branches: { dieIndex: number; detail: MoveDetail }[] = [];
    for (let i = 0; i < remaining.length; i++) {
      const d = remaining[i]!;
      // 相同骰点在同一层会产生重复分支，只保留首个槽位。
      if (remaining.indexOf(d) !== i) continue;
      for (const p of legalMovesForDie(board.points, d).map((m) => m.p)) {
        const detail = applyMove(board, p, d);
        branches.push({ dieIndex: i, detail });
      }
    }

    if (branches.length === 0) {
      // 路径终止：无棋子或无可用合法骰子。
      const key = moves.map((m) => `${m.p}-${m.d}`).join("|");
      if (!dedup.has(key)) {
        dedup.add(key);
        const end: Board = { points: board.points, borneOff: board.borneOff };
        collected.push({
          moves,
          end,
          unused: collectUnused(end, remaining),
          usedCount: moves.length,
          cleared: onBoardCount(end.points) === 0,
        });
      }
      continue;
    }

    for (const branch of branches) {
      const nextRemaining = remaining.slice();
      nextRemaining.splice(branch.dieIndex, 1);
      const nextBoard: Board = {
        points: branch.detail.after,
        borneOff: branch.detail.borneOffAfter,
      };
      stack.push({
        board: nextBoard,
        remaining: nextRemaining,
        moves: [...moves, branch.detail],
      });
    }
  }

  // 受限大骰优先：在“所有”候选上强制（含提前离盘完毕路径）。
  let candidates = collected;
  if (distinct && largerUsableAtRoot) {
    candidates = collected.filter((path) => path.moves[0]?.d === larger);
  }

  // 仅保留用骰次数最多者。
  let maxUsed = 0;
  for (const path of candidates) if (path.usedCount > maxUsed) maxUsed = path.usedCount;
  const paths = candidates.filter((path) => path.usedCount === maxUsed);

  // 稳定排序：按来源点、骰点序列字典序，保证确定性输出。
  paths.sort((a, b) => {
    const n = Math.max(a.moves.length, b.moves.length);
    for (let i = 0; i < n; i++) {
      const am = a.moves[i];
      const bm = b.moves[i];
      if (!am) return -1;
      if (!bm) return 1;
      if (am.p !== bm.p) return am.p - bm.p;
      if (am.d !== bm.d) return am.d - bm.d;
    }
    return 0;
  });

  return {
    paths,
    maxUsedCount: maxUsed,
    complete: !truncated,
    nodesExpanded: nodes,
    budget,
  };
}

/** 空盘面等场景的便捷构造，用于测试。 */
export function emptyBoard(): Board {
  const zero: Points = [0, 0, 0, 0, 0, 0];
  return boardFromPoints(zero, 0);
}
