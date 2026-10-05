import { Store, StoreError } from "./db/store.ts";
import type { TurnRow } from "./db/store.ts";
import { RULES_VERSION } from "./engine/types.ts";
import type { Board, EnumerationResult } from "./engine/types.ts";
import {
  applyMove,
  canMove,
  conservationHolds,
  isDieFace,
  onBoardCount,
  toPoints,
  validatePoints,
} from "./engine/rules.ts";
import { enumeratePaths } from "./engine/enumerate.ts";
import { validatePath } from "./engine/validate.ts";
import type { SubmittedStep } from "./engine/validate.ts";

export class ServiceError extends Error {
  errorCode: string;
  status: number;
  constructor(
    errorCode: string,
    message: string,
    status = 400,
  ) {
    super(message);
    this.name = "ServiceError";
    this.errorCode = errorCode;
    this.status = status;
  }
}

export interface CreateGameInput {
  points: number[];
  borneOff?: number;
  totalCheckers?: number;
  budget?: number;
}

export interface GameView {
  id: string;
  totalCheckers: number;
  budget: number;
  rulesVersion: string;
  board: Board;
  currentTurn: number | null;
}

const DEFAULT_TOTAL = 15;
const DEFAULT_BUDGET = 100000;

export class BackgammonService {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  createGame(input: CreateGameInput, id = randomId()): GameView {
    const pointsErr = validatePoints(input.points);
    if (pointsErr) throw new ServiceError(pointsErr, "六个点必须为长度 6 的非负整数数组");
    const points = toPoints(input.points);
    const borneOff = input.borneOff ?? 0;
    if (!Number.isInteger(borneOff) || borneOff < 0) {
      throw new ServiceError("INVALID_BORNE_OFF", "已离盘数量必须为非负整数");
    }
    const totalCheckers = input.totalCheckers ?? DEFAULT_TOTAL;
    if (!Number.isInteger(totalCheckers) || totalCheckers <= 0) {
      throw new ServiceError("INVALID_TOTAL", "总棋子数必须为正整数");
    }
    const onBoard = onBoardCount(points);
    if (onBoard + borneOff > totalCheckers) {
      throw new ServiceError(
        "TOTAL_EXCEEDED",
        `盘内 ${onBoard} + 离盘 ${borneOff} 超过总棋子数 ${totalCheckers}`,
      );
    }
    const budget = input.budget ?? DEFAULT_BUDGET;
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new ServiceError("INVALID_BUDGET", "枚举预算必须为正整数");
    }
    if (onBoard + borneOff !== totalCheckers) {
      throw new ServiceError(
        "CONSERVATION_VIOLATION",
        `盘内 + 离盘 = ${onBoard + borneOff}，必须等于总棋子数 ${totalCheckers}`,
      );
    }
    const initial: Board = { points, borneOff };
    this.store.createGame(id, totalCheckers, budget, initial);
    return this.gameView(id);
  }

  getGame(gameId: string): GameView {
    this.requireGame(gameId);
    return this.gameView(gameId);
  }

  private gameView(gameId: string): GameView {
    const game = this.store.getGame(gameId)!;
    const latest = this.store.latestTurn(gameId);
    const board = latest
      ? latest.status === "submitted" && latest.endPoints
        ? { points: latest.endPoints, borneOff: latest.endBorneOff! }
        : { points: latest.startPoints, borneOff: latest.startBorneOff }
      : this.initialBoard(gameId);
    return {
      id: game.id,
      totalCheckers: game.totalCheckers,
      budget: game.budget,
      rulesVersion: game.rulesVersion,
      board,
      currentTurn: latest?.id ?? null,
    };
  }

  private initialBoard(gameId: string): Board {
    const game = this.store.getGame(gameId)!;
    return { points: game.initialPoints, borneOff: game.initialBorneOff };
  }

  private requireGame(gameId: string) {
    const game = this.store.getGame(gameId);
    if (!game) throw new ServiceError("GAME_NOT_FOUND", `残局 ${gameId} 不存在`, 404);
    return game;
  }

  /** 本回合开始时的盘面（即当前最新状态）。 */
  private boardForNewTurn(gameId: string): Board {
    const latest = this.store.latestTurn(gameId);
    if (!latest) return this.initialBoard(gameId);
    if (latest.status === "pending") {
      return { points: latest.startPoints, borneOff: latest.startBorneOff };
    }
    return { points: latest.endPoints!, borneOff: latest.endBorneOff! };
  }

  rollDice(gameId: string, d1: number, d2: number): { turnId: number; board: Board; d1: number; d2: number } {
    const game = this.requireGame(gameId);
    if (!isDieFace(d1) || !isDieFace(d2)) {
      throw new ServiceError("INVALID_DICE", "两个骰点都必须是 1..6 的整数");
    }
    const latest = this.store.latestTurn(gameId);
    if (latest && latest.status === "pending") {
      throw new ServiceError("TURN_OPEN", `回合 ${latest.id} 尚未提交，请先提交或使用该回合`);
    }
    const board = this.boardForNewTurn(gameId);
    if (!conservationHolds(board, game.totalCheckers)) {
      throw new ServiceError("CONSERVATION_VIOLATION", "当前盘面数量不守恒");
    }
    const turnId = this.store.createTurn(gameId, d1, d2, board);
    return { turnId, board, d1, d2 };
  }

  getTurn(turnId: number): TurnView {
    const turn = this.requireTurn(turnId);
    const game = this.store.getGame(turn.gameId)!;
    return this.turnView(turn, game.totalCheckers, game.budget, null);
  }

  private requireTurn(turnId: number): TurnRow {
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new ServiceError("TURN_NOT_FOUND", `回合 ${turnId} 不存在`, 404);
    return turn;
  }

  listPaths(turnId: number): TurnView {
    const turn = this.requireTurn(turnId);
    const game = this.store.getGame(turn.gameId)!;
    const enumeration = enumeratePaths(
      { points: turn.startPoints, borneOff: turn.startBorneOff },
      turn.d1,
      turn.d2,
      game.budget,
    );
    return this.turnView(turn, game.totalCheckers, game.budget, enumeration);
  }

  explainStep(turnId: number, stepIndex: number, p: number, d: number) {
    const turn = this.requireTurn(turnId);
    // 解释接口可以针对“假设逐步执行”的某一步；这里解释从回合初态直接走一步的局部情况，
    // 也允许通过 replay 到指定步骤。为简单明确：解释从初态执行给定 (p,d) 的一步。
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      throw new ServiceError("INVALID_STEP_INDEX", "步骤序号必须为非负整数");
    }
    // 重新播放前 stepIndex 步（来自已提交路径或调用方无关），本接口解释初态单步。
    const start: Board = { points: turn.startPoints, borneOff: turn.startBorneOff };
    if (!canMove(start.points, p, d)) {
      throw new ServiceError("ILLEGAL_MOVE", `点 ${p} 在回合初态不能使用骰点 ${d}`);
    }
    const detail = applyMove(start, p, d);
    return { turnId, stepIndex, detail };
  }

  submitPath(turnId: number, steps: SubmittedStep[], expectedTurn?: number) {
    if (expectedTurn !== undefined && expectedTurn !== turnId) {
      throw new ServiceError(
        "TURN_EXPIRED",
        `客户端回合号 ${expectedTurn} 与目标回合 ${turnId} 不一致（回合已过期）`,
        409,
      );
    }
    const turn = this.requireTurn(turnId);
    const game = this.store.getGame(turn.gameId)!;

    // 过期回合号：必须是该残局的最新回合，才能提交。
    const latest = this.store.latestTurn(turn.gameId);
    if (!latest || latest.id !== turnId) {
      throw new ServiceError("TURN_EXPIRED", `回合 ${turnId} 已过期，当前回合为 ${latest?.id}`, 409);
    }

    const start: Board = { points: turn.startPoints, borneOff: turn.startBorneOff };
    const verdict = validatePath(start, turn.d1, turn.d2, steps, game.totalCheckers);
    if (!verdict.ok) {
      throw new ServiceError(verdict.errorCode, verdict.message, 422);
    }

    // 临时状态核验通过后，进入事务一次性落盘。
    const end = verdict.path.end;
    try {
      this.store.submitTurn(turnId, () => ({ end, steps, result: true }));
    } catch (err) {
      if (err instanceof StoreError) {
        throw new ServiceError(err.errorCode, err.message, 409);
      }
      throw err;
    }
    return this.listPaths(turnId);
  }

  replayTurn(turnId: number): { turn: TurnView; replayed: SubmittedStep[] } {
    const turn = this.requireTurn(turnId);
    if (turn.status !== "submitted" || !turn.chosenPath) {
      throw new ServiceError("TURN_NOT_SUBMITTED", `回合 ${turnId} 尚未提交，无法重放`);
    }
    const game = this.store.getGame(turn.gameId)!;
    const start: Board = { points: turn.startPoints, borneOff: turn.startBorneOff };
    const verdict = validatePath(start, turn.d1, turn.d2, turn.chosenPath, game.totalCheckers);
    if (!verdict.ok) {
      throw new ServiceError(verdict.errorCode, `重放核验失败：${verdict.message}`, 500);
    }
    return {
      turn: this.turnView(turn, game.totalCheckers, game.budget, null, verdict.path.end),
      replayed: turn.chosenPath,
    };
  }

  exportGame(gameId: string) {
    this.requireGame(gameId);
    const game = this.store.getGame(gameId)!;
    const turns = this.store.listTurns(gameId).map((t) => ({
      turnId: t.id,
      dice: [t.d1, t.d2],
      start: { points: t.startPoints, borneOff: t.startBorneOff },
      end:
        t.status === "submitted" && t.endPoints
          ? { points: t.endPoints, borneOff: t.endBorneOff }
          : null,
      status: t.status,
      chosenPath: t.chosenPath,
      createdAt: t.createdAt,
      submittedAt: t.submittedAt,
    }));
    return {
      rulesVersion: RULES_VERSION,
      game: {
        id: game.id,
        totalCheckers: game.totalCheckers,
        budget: game.budget,
      },
      current: this.gameView(gameId),
      turns,
    };
  }

  private turnView(
    turn: TurnRow,
    totalCheckers: number,
    budget: number,
    enumeration: EnumerationResult | null,
    overrideEnd?: Board,
  ): TurnView {
    const start = { points: turn.startPoints, borneOff: turn.startBorneOff };
    const end =
      overrideEnd ??
      (turn.status === "submitted" && turn.endPoints
        ? { points: turn.endPoints, borneOff: turn.endBorneOff! }
        : null);
    return {
      turnId: turn.id,
      gameId: turn.gameId,
      dice: [turn.d1, turn.d2],
      status: turn.status,
      start,
      end,
      chosenPath: turn.chosenPath,
      totalCheckers,
      enumeration: enumeration
        ? {
            complete: enumeration.complete,
            maxUsedCount: enumeration.maxUsedCount,
            nodesExpanded: enumeration.nodesExpanded,
            budget: enumeration.budget,
            pathCount: enumeration.paths.length,
            paths: enumeration.paths.map((path) => ({
              moves: path.moves.map((m) => ({
                p: m.p,
                d: m.d,
                borneOff: m.borneOff,
                toP: m.toP,
                before: m.before,
                after: m.after,
                borneOffBefore: m.borneOffBefore,
                borneOffAfter: m.borneOffAfter,
              })),
              end: path.end,
              unused: path.unused,
              usedCount: path.usedCount,
              cleared: path.cleared,
            })),
          }
        : null,
    };
  }
}

export interface TurnView {
  turnId: number;
  gameId: string;
  dice: [number, number];
  status: "pending" | "submitted";
  start: Board;
  end: Board | null;
  chosenPath: SubmittedStep[] | null;
  totalCheckers: number;
  enumeration: {
    complete: boolean;
    maxUsedCount: number;
    nodesExpanded: number;
    budget: number;
    pathCount: number;
    paths: unknown[];
  } | null;
}

function randomId(): string {
  return "g_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
