import { NUM_POINTS } from "./types.ts";
import type { Board, DieFace, Move, MoveDetail, Points } from "./types.ts";

/** 校验六个点是否合法：长度、整数、非负。返回错误码，合法返回 null。 */
export function validatePoints(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length !== NUM_POINTS) return "INVALID_POINTS";
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return "INVALID_POINTS";
  }
  return null;
}

export function toPoints(raw: number[]): Points {
  return [raw[0]!, raw[1]!, raw[2]!, raw[3]!, raw[4]!, raw[5]!];
}

export function isDieFace(v: unknown): v is DieFace {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 6;
}

export function clonePoints(points: Points): [number, number, number, number, number, number] {
  return [points[0]!, points[1]!, points[2]!, points[3]!, points[4]!, points[5]!];
}

export function boardFromPoints(points: Points, borneOff = 0): Board {
  return { points: clonePoints(points), borneOff };
}

export function onBoardCount(points: Points): number {
  return points[0]! + points[1]! + points[2]! + points[3]! + points[4]! + points[5]!;
}

/** 守恒检查：盘内 + 离盘 是否等于总数。 */
export function conservationHolds(board: Board, totalCheckers: number): boolean {
  return onBoardCount(board.points) + board.borneOff === totalCheckers;
}

/**
 * 判断在给定盘面下，位于来源点 p（1..6）的棋子能否使用骰点 d（1..6）。
 * 规则：
 *  - 该点必须有棋子；
 *  - p > d：移动到 p-d，不允许离盘；
 *  - p = d：精确离盘；
 *  - d > p：仅当所有“比 p 更远”的点（p+1..6）都没有棋子时，才允许超点离盘。
 */
export function canMove(points: Points, p: number, d: number): boolean {
  if (p < 1 || p > NUM_POINTS || !isDieFace(d)) return false;
  if (points[p - 1]! <= 0) return false;
  if (p === d) return true;
  if (p > d) return true; // 移动到更近的点 p-d
  // d > p：超点离盘，需要更远的点全部为空
  for (let q = p + 1; q <= NUM_POINTS; q++) {
    if (points[q - 1]! > 0) return false;
  }
  return true;
}

/**
 * 应用一步移动，返回新的移动明细。调用方应先用 canMove 校验。
 * 不就地修改输入盘面。
 */
export function applyMove(board: Board, p: number, d: number): MoveDetail {
  if (!canMove(board.points, p, d)) {
    throw new Error(`ILLEGAL_MOVE: 点 ${p} 不能使用骰点 ${d}`);
  }
  const before = clonePoints(board.points);
  const after = clonePoints(board.points);
  let borneOff = false;
  let toP: number | null = null;
  let borneOffAfter = board.borneOff;

  after[p - 1] = after[p - 1]! - 1;
  if (p === d || d > p) {
    borneOff = true;
    borneOffAfter += 1;
  } else {
    // p > d：移动到 p-d
    toP = p - d;
    after[toP - 1] = after[toP - 1]! + 1;
  }

  return {
    p,
    d,
    borneOff,
    toP,
    before,
    after,
    borneOffBefore: board.borneOff,
    borneOffAfter,
  };
}

/** 列出给定盘面、给定骰点下所有来源点互异的合法移动（棋子不可区分，不去重身份）。 */
export function legalMovesForDie(points: Points, d: number): Move[] {
  const moves: Move[] = [];
  for (let p = 1; p <= NUM_POINTS; p++) {
    if (canMove(points, p, d)) {
      const borneOff = p <= d;
      moves.push({ p, d, borneOff, toP: borneOff ? null : p - d });
    }
  }
  return moves;
}

/** 是否存在任意一颗骰子可合法使用。 */
export function anyDieUsable(points: Points, dice: number[]): boolean {
  return dice.some((d) => legalMovesForDie(points, d).length > 0);
}
