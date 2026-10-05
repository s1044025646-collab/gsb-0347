import type { Board, MoveDetail, PathResult, Points } from "./types.ts";
import {
  applyMove,
  boardFromPoints,
  canMove,
  conservationHolds,
  isDieFace,
  onBoardCount,
  toPoints,
} from "./rules.ts";
import { enumeratePaths } from "./enumerate.ts";

export interface ValidateOk {
  ok: true;
  path: PathResult;
}

export interface ValidateError {
  ok: false;
  errorCode:
    | "INVALID_MOVE_SHAPE"
    | "ILLEGAL_MOVE"
    | "NOT_MAXIMAL"
    | "NOT_LARGE_DIE_FIRST"
    | "DIE_NOT_AVAILABLE"
    | "CONSERVATION_VIOLATION"
    | "ENUMERATION_INCOMPLETE";
  message: string;
  /** 出错时已推进到的步数（0 基）。 */
  atStep?: number;
}

export type ValidateResult = ValidateOk | ValidateError;

/** 待核验的一步：仅需来源点与骰点；离盘由规则推出。 */
export interface SubmittedStep {
  p: number;
  d: number;
}

/**
 * 核验提交路径。不仅逐步检查局部合法性，还通过独立的完整枚举确认：
 *  - 每一步的骰点确实来自本回合骰槽（异骰各一次 / 双骰至多四次）；
 *  - 整条路径用骰次数达到本回合最大值（拒绝只提交合法前缀）；
 *  - 满足受限大骰优先；
 *  - 每步前后数量守恒。
 *
 * 核验使用独立的、足够大的预算；若仍不完整则明确返回
 * ENUMERATION_INCOMPLETE，绝不凭截短结果下结论。
 */
export function validatePath(
  initial: Board,
  d1: number,
  d2: number,
  steps: SubmittedStep[],
  totalCheckers: number,
  verifyBudget = 200000,
): ValidateResult {
  if (!conservationHolds(initial, totalCheckers)) {
    return { ok: false, errorCode: "CONSERVATION_VIOLATION", message: "初态数量不守恒" };
  }
  if (!Array.isArray(steps)) {
    return { ok: false, errorCode: "INVALID_MOVE_SHAPE", message: "路径必须是数组" };
  }

  // 骰槽计数：异骰各一次，双骰四次。
  const slots = new Map<number, number>();
  if (d1 === d2) slots.set(d1, 4);
  else {
    slots.set(d1, 1);
    slots.set(d2, 1);
  }

  let board: Board = boardFromPoints(initial.points, initial.borneOff);
  const details: MoveDetail[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (
      typeof step !== "object" ||
      step === null ||
      typeof step.p !== "number" ||
      typeof step.d !== "number" ||
      !Number.isInteger(step.p) ||
      !Number.isInteger(step.d)
    ) {
      return {
        ok: false,
        errorCode: "INVALID_MOVE_SHAPE",
        message: `第 ${i + 1} 步缺少合法的来源点或骰点`,
        atStep: i,
      };
    }
    const { p, d } = step;
    if (p < 1 || p > 6 || !isDieFace(d)) {
      return {
        ok: false,
        errorCode: "INVALID_MOVE_SHAPE",
        message: `第 ${i + 1} 步点位/骰点超出范围`,
        atStep: i,
      };
    }
    const remainingUses = slots.get(d) ?? 0;
    if (remainingUses <= 0) {
      return {
        ok: false,
        errorCode: "DIE_NOT_AVAILABLE",
        message: `第 ${i + 1} 步骰点 ${d} 已用尽或不属于本回合`,
        atStep: i,
      };
    }
    if (!canMove(board.points, p, d)) {
      return {
        ok: false,
        errorCode: "ILLEGAL_MOVE",
        message: explainIllegal(board.points, p, d, i),
        atStep: i,
      };
    }
    const detail = applyMove(board, p, d);
    board = { points: detail.after, borneOff: detail.borneOffAfter };
    if (!conservationHolds(board, totalCheckers)) {
      return {
        ok: false,
        errorCode: "CONSERVATION_VIOLATION",
        message: `第 ${i + 1} 步后数量不守恒`,
        atStep: i,
      };
    }
    slots.set(d, remainingUses - 1);
    details.push(detail);
  }

  // 独立完整枚举，检查最大用骰与大骰优先。
  const enumeration = enumeratePaths(initial, d1, d2, verifyBudget);
  if (!enumeration.complete) {
    return {
      ok: false,
      errorCode: "ENUMERATION_INCOMPLETE",
      message: "核验枚举未完成，无法确认全局最大用骰",
    };
  }

  const key = (ds: MoveDetail[]) => ds.map((m) => `${m.p}-${m.d}`).join("|");
  const submittedKey = key(details);
  const accepted = enumeration.paths.some((path) => key(path.moves) === submittedKey);

  if (!accepted) {
    // 区分“只是没走满”与“大骰优先”两类，便于 CLI/API 提示。
    if (details.length < enumeration.maxUsedCount) {
      return {
        ok: false,
        errorCode: "NOT_MAXIMAL",
        message: `路径只用了 ${details.length} 颗骰子，本回合最多可用 ${enumeration.maxUsedCount} 颗；合法前缀不被接受`,
      };
    }
    return {
      ok: false,
      errorCode: "NOT_LARGE_DIE_FIRST",
      message: "路径不满足受限大骰优先或不是规范完整路径",
    };
  }

  const match = enumeration.paths.find((path) => key(path.moves) === submittedKey)!;
  return { ok: true, path: match };
}

function explainIllegal(points: Points, p: number, d: number, i: number): string {
  if (points[p - 1]! <= 0) return `第 ${i + 1} 步：点 ${p} 上没有棋子`;
  if (d > p) {
    const blockers: number[] = [];
    for (let q = p + 1; q <= 6; q++) if (points[q - 1]! > 0) blockers.push(q);
    return `第 ${i + 1} 步：点 ${p} 想用 ${d} 超点离盘，但更远的点 [${blockers.join(", ")}] 仍有棋子`;
  }
  return `第 ${i + 1} 步：点 ${p} 使用骰点 ${d} 不合法`;
}

export { onBoardCount, toPoints };
