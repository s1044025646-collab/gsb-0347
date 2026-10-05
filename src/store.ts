import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Position,
  RULES_VERSION,
  RuleError,
  validatePosition,
  validateDice,
  enumeratePaths,
  verifySubmittedPath,
  DEFAULT_ENUM_BUDGET,
  EnumerateResult,
} from "./rules.js";

export interface GameRow {
  id: number;
  rules_version: string;
  total_checkers: number;
  enum_budget: number;
  initial_json: string;
  current_json: string;
  next_turn: number;
  created_at: string;
}

export interface TurnRow {
  id: number;
  game_id: number;
  turn_no: number;
  die1: number;
  die2: number;
  status: string;
  start_json: string;
  paths_json: string;
  complete: number;
  submitted_json: string | null;
  result_json: string | null;
  created_at: string;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rules_version TEXT NOT NULL,
        total_checkers INTEGER NOT NULL,
        enum_budget INTEGER NOT NULL,
        initial_json TEXT NOT NULL,
        current_json TEXT NOT NULL,
        next_turn INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES games(id),
        turn_no INTEGER NOT NULL,
        die1 INTEGER NOT NULL,
        die2 INTEGER NOT NULL,
        status TEXT NOT NULL,
        start_json TEXT NOT NULL,
        paths_json TEXT NOT NULL,
        complete INTEGER NOT NULL,
        submitted_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(game_id, turn_no)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createGame(opts: {
    points: unknown;
    borneOff: unknown;
    totalCheckers?: unknown;
    budget?: unknown;
  }): GameRow {
    const v = validatePosition(opts.points, opts.borneOff ?? 0, opts.totalCheckers);
    let budget = DEFAULT_ENUM_BUDGET;
    if (opts.budget !== undefined) {
      if (
        typeof opts.budget !== "number" ||
        !Number.isInteger(opts.budget) ||
        opts.budget <= 0
      ) {
        throw new RuleError("INVALID_BUDGET", "budget 必须是正整数");
      }
      budget = opts.budget;
    }
    const initial: Position = { points: v.points, borneOff: v.borneOff };
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO games (rules_version, total_checkers, enum_budget, initial_json, current_json, next_turn, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        RULES_VERSION,
        v.totalCheckers,
        budget,
        JSON.stringify(initial),
        JSON.stringify(initial),
        now,
      );
    return this.getGame(Number(r.lastInsertRowid));
  }

  getGame(id: number): GameRow {
    const row = this.db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as
      | GameRow
      | undefined;
    if (!row) throw new RuleError("GAME_NOT_FOUND", `对局 ${id} 不存在`);
    return row;
  }

  getTurn(gameId: number, turnNo: number): TurnRow {
    const row = this.db
      .prepare(`SELECT * FROM turns WHERE game_id = ? AND turn_no = ?`)
      .get(gameId, turnNo) as TurnRow | undefined;
    if (!row) {
      throw new RuleError("TURN_NOT_FOUND", `对局 ${gameId} 回合 ${turnNo} 不存在`);
    }
    return row;
  }

  listTurns(gameId: number): TurnRow[] {
    return this.db
      .prepare(`SELECT * FROM turns WHERE game_id = ? ORDER BY turn_no`)
      .all(gameId) as unknown as TurnRow[];
  }

  createTurn(
    gameId: number,
    die1: unknown,
    die2: unknown,
  ): { turn: TurnRow; en: EnumerateResult } {
    const [d1, d2] = validateDice(die1, die2);
    const game = this.getGame(gameId);
    const start = JSON.parse(game.current_json) as Position;
    const en = enumeratePaths(start, d1, d2, game.enum_budget);
    const turnNo = game.next_turn;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO turns (game_id, turn_no, die1, die2, status, start_json, paths_json, complete, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(
        gameId,
        turnNo,
        d1,
        d2,
        JSON.stringify(start),
        JSON.stringify(en.paths),
        en.complete ? 1 : 0,
        now,
      );
    this.db
      .prepare(`UPDATE games SET next_turn = next_turn + 1 WHERE id = ?`)
      .run(gameId);
    return { turn: this.getTurn(gameId, turnNo), en };
  }

  submitPath(
    gameId: number,
    turnNo: number,
    moves: { from: number; die: number }[],
  ): { turn: TurnRow; result: unknown } {
    const game = this.getGame(gameId);
    const turn = this.getTurn(gameId, turnNo);
    if (turn.status === "submitted") {
      throw new RuleError("TURN_ALREADY_SUBMITTED", `回合 ${turnNo} 已提交`);
    }
    if (turnNo !== game.next_turn - 1) {
      throw new RuleError(
        "STALE_TURN",
        `回合号 ${turnNo} 已过期，当前待提交回合为 ${game.next_turn - 1}`,
      );
    }
    const start = JSON.parse(turn.start_json) as Position;
    const result = verifySubmittedPath(start, turn.die1, turn.die2, moves, game.enum_budget);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE turns SET status = 'submitted', submitted_json = ?, result_json = ? WHERE id = ?`,
        )
        .run(JSON.stringify(moves), JSON.stringify(result), turn.id);
      this.db
        .prepare(`UPDATE games SET current_json = ? WHERE id = ?`)
        .run(JSON.stringify(result.finalPosition), gameId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { turn: this.getTurn(gameId, turnNo), result };
  }

  replay(gameId: number): { finalPosition: Position; turns: number } {
    const game = this.getGame(gameId);
    let pos = JSON.parse(game.initial_json) as Position;
    const turns = this.listTurns(gameId).filter((t) => t.status === "submitted");
    for (const t of turns) {
      const moves = JSON.parse(t.submitted_json!) as { from: number; die: number }[];
      const r = verifySubmittedPath(pos, t.die1, t.die2, moves, game.enum_budget);
      pos = r.finalPosition;
    }
    return { finalPosition: pos, turns: turns.length };
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "sixpoint.db");
}
