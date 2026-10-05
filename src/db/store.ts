import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RULES_VERSION } from "../engine/types.ts";
import type { Board, Points } from "../engine/types.ts";
import type { SubmittedStep } from "../engine/validate.ts";

export interface GameRow {
  id: string;
  totalCheckers: number;
  budget: number;
  rulesVersion: string;
  createdAt: string;
  initialPoints: Points;
  initialBorneOff: number;
}

export interface TurnRow {
  id: number;
  gameId: string;
  d1: number;
  d2: number;
  startPoints: Points;
  startBorneOff: number;
  endPoints: Points | null;
  endBorneOff: number | null;
  status: "pending" | "submitted";
  chosenPath: SubmittedStep[] | null;
  createdAt: string;
  submittedAt: string | null;
}

function parsePoints(s: string): Points {
  const arr = JSON.parse(s) as number[];
  return [arr[0]!, arr[1]!, arr[2]!, arr[3]!, arr[4]!, arr[5]!];
}

/** SQLite 持久层。提交在单个事务内核验后一次性落盘，失败整体回滚。 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPathOrInstance: string | DatabaseSync) {
    if (typeof dbPathOrInstance === "string") {
      mkdirSync(dirname(dbPathOrInstance), { recursive: true });
      this.db = new DatabaseSync(dbPathOrInstance);
    } else {
      this.db = dbPathOrInstance;
    }
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        total_checkers INTEGER NOT NULL,
        budget INTEGER NOT NULL,
        rules_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        initial_points TEXT NOT NULL,
        initial_borne_off INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL REFERENCES games(id),
        d1 INTEGER NOT NULL,
        d2 INTEGER NOT NULL,
        start_points TEXT NOT NULL,
        start_borne_off INTEGER NOT NULL,
        end_points TEXT,
        end_borne_off INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        chosen_path TEXT,
        created_at TEXT NOT NULL,
        submitted_at TEXT
      );
    `);
  }

  createGame(id: string, totalCheckers: number, budget: number, initial: Board): GameRow {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO games (id, total_checkers, budget, rules_version, created_at, initial_points, initial_borne_off)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        totalCheckers,
        budget,
        RULES_VERSION,
        createdAt,
        JSON.stringify(initial.points),
        initial.borneOff,
      );
    return {
      id,
      totalCheckers,
      budget,
      rulesVersion: RULES_VERSION,
      createdAt,
      initialPoints: initial.points,
      initialBorneOff: initial.borneOff,
    };
  }

  getGame(id: string): GameRow | null {
    const row = this.db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      totalCheckers: row.total_checkers as number,
      budget: row.budget as number,
      rulesVersion: row.rules_version as string,
      createdAt: row.created_at as string,
      initialPoints: parsePoints(row.initial_points as string),
      initialBorneOff: row.initial_borne_off as number,
    };
  }

  createTurn(gameId: string, d1: number, d2: number, start: Board): number {
    const createdAt = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO turns (game_id, d1, d2, start_points, start_borne_off, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(gameId, d1, d2, JSON.stringify(start.points), start.borneOff, createdAt);
    return Number(info.lastInsertRowid);
  }

  getTurn(turnId: number): TurnRow | null {
    const row = this.db.prepare(`SELECT * FROM turns WHERE id = ?`).get(turnId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToTurn(row);
  }

  listTurns(gameId: string): TurnRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE game_id = ? ORDER BY id ASC`)
      .all(gameId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToTurn(r));
  }

  latestTurn(gameId: string): TurnRow | null {
    const row = this.db
      .prepare(`SELECT * FROM turns WHERE game_id = ? ORDER BY id DESC LIMIT 1`)
      .get(gameId) as Record<string, unknown> | undefined;
    return row ? this.rowToTurn(row) : null;
  }

  /**
   * 在事务中提交路径。mutator 接收当前回合并返回终态/路径；
   * 若抛错则整体回滚，前面移动的棋子不落盘。
   */
  submitTurn<T>(
    turnId: number,
    mutator: (turn: TurnRow) => { end: Board; steps: SubmittedStep[]; result: T },
  ): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getTurn(turnId);
      if (!current) throw new StoreError("TURN_NOT_FOUND", "回合不存在");
      if (current.status === "submitted") {
        throw new StoreError("TURN_ALREADY_SUBMITTED", "该回合已提交，不能重复提交");
      }
      const { end, steps, result } = mutator(current);
      this.db
        .prepare(
          `UPDATE turns
             SET end_points = ?, end_borne_off = ?, status = 'submitted',
                 chosen_path = ?, submitted_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(end.points),
          end.borneOff,
          JSON.stringify(steps),
          new Date().toISOString(),
          turnId,
        );
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private rowToTurn(row: Record<string, unknown>): TurnRow {
    return {
      id: row.id as number,
      gameId: row.game_id as string,
      d1: row.d1 as number,
      d2: row.d2 as number,
      startPoints: parsePoints(row.start_points as string),
      startBorneOff: row.start_borne_off as number,
      endPoints: row.end_points ? parsePoints(row.end_points as string) : null,
      endBorneOff: (row.end_borne_off as number | null) ?? null,
      status: row.status as "pending" | "submitted",
      chosenPath: row.chosen_path ? (JSON.parse(row.chosen_path as string) as SubmittedStep[]) : null,
      createdAt: row.created_at as string,
      submittedAt: (row.submitted_at as string | null) ?? null,
    };
  }
}

export class StoreError extends Error {
  errorCode: string;
  constructor(errorCode: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.errorCode = errorCode;
  }
}
