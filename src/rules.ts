// 六点残局核心规则引擎（规则版本 sixpoint-v1）
// 仅保留本方内盘 1..6 点，1 距离离盘 1 步，6 距离离盘 6 步。

export const RULES_VERSION = "sixpoint-v1";
export const DEFAULT_TOTAL_CHECKERS = 15;
export const DEFAULT_ENUM_BUDGET = 100000;

export interface Position {
  // points[1..6]，points[0] 恒为 0 占位
  points: number[];
  borneOff: number;
}

export interface Move {
  from: number; // 来源点 1..6
  die: number; // 使用的骰点 1..6
  bearOff: boolean; // 本步是否离盘
}

export interface StepResult {
  ok: boolean;
  code?: string;
  reason?: string;
  before?: Position;
  after?: Position;
  move?: Move;
}

export class RuleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function clonePosition(pos: Position): Position {
  return { points: pos.points.slice(), borneOff: pos.borneOff };
}

export function checkersOnBoard(pos: Position): number {
  let n = 0;
  for (let p = 1; p <= 6; p++) n += pos.points[p];
  return n;
}

export function validatePosition(
  points: unknown,
  borneOff: unknown,
  totalCheckers: unknown,
): { points: number[]; borneOff: number; totalCheckers: number } {
  if (!Array.isArray(points) || points.length !== 6) {
    throw new RuleError("INVALID_POINTS", "points 必须是长度为 6 的数组（对应 1..6 点）");
  }
  const arr: number[] = [0];
  for (let i = 0; i < 6; i++) {
    const v = points[i];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new RuleError("NON_INTEGER", `第 ${i + 1} 点数量不是整数`);
    }
    if (v < 0) throw new RuleError("NEGATIVE_COUNT", `第 ${i + 1} 点数量为负`);
    arr.push(v);
  }
  if (typeof borneOff !== "number" || !Number.isInteger(borneOff)) {
    throw new RuleError("NON_INTEGER", "borneOff 不是整数");
  }
  if (borneOff < 0) throw new RuleError("NEGATIVE_COUNT", "borneOff 为负");
  const total =
    totalCheckers === undefined
      ? DEFAULT_TOTAL_CHECKERS
      : totalCheckers;
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) {
    throw new RuleError("INVALID_TOTAL", "totalCheckers 必须是正整数");
  }
  const onBoard = arr.reduce((a, b) => a + b, 0);
  if (onBoard + borneOff > total) {
    throw new RuleError(
      "EXCEEDS_TOTAL",
      `盘内 ${onBoard} + 已离盘 ${borneOff} 超过总棋子数 ${total}`,
    );
  }
  return { points: arr, borneOff, totalCheckers: total };
}

export function validateDice(die1: unknown, die2: unknown): [number, number] {
  for (const d of [die1, die2]) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 6) {
      throw new RuleError("INVALID_DIE", "骰点必须是 1..6 的整数");
    }
  }
  return [die1 as number, die2 as number];
}

// 判断某枚棋子能否用骰点 d 从 p 离盘（含超点离盘规则）
export function canBearOffFrom(pos: Position, p: number, d: number): boolean {
  if (d < p) return false;
  if (d === p) return true;
  // d > p：仅当比 p 更远的点都没有棋子
  for (let q = p + 1; q <= 6; q++) {
    if (pos.points[q] > 0) return false;
  }
  return true;
}

// 对位置应用一步移动；非法时抛出 RuleError
export function applyMove(pos: Position, from: number, die: number): Position {
  if (!Number.isInteger(from) || from < 1 || from > 6) {
    throw new RuleError("INVALID_POINT", `来源点 ${from} 非法，必须在 1..6`);
  }
  if (!Number.isInteger(die) || die < 1 || die > 6) {
    throw new RuleError("INVALID_DIE", `骰点 ${die} 非法，必须在 1..6`);
  }
  if (pos.points[from] <= 0) {
    throw new RuleError("EMPTY_POINT", `第 ${from} 点没有棋子`);
  }
  const next = clonePosition(pos);
  next.points[from] -= 1;
  if (die < from) {
    next.points[from - die] += 1;
  } else {
    if (!canBearOffFrom(pos, from, die)) {
      throw new RuleError(
        "BLOCKED_BY_HIGHER",
        `第 ${from} 点不能用 ${die} 超点离盘：更远的点上仍有棋子`,
      );
    }
    next.borneOff += 1;
  }
  return next;
}

// 解释一步：返回前后数量与合法性说明（不修改输入）
export function explainStep(pos: Position, from: number, die: number): StepResult {
  const before = clonePosition(pos);
  try {
    const after = applyMove(pos, from, die);
    return {
      ok: true,
      before,
      after,
      move: { from, die, bearOff: die >= from },
    };
  } catch (e) {
    if (e instanceof RuleError) {
      return { ok: false, code: e.code, reason: e.message, before };
    }
    throw e;
  }
}

// 当前位置下某骰点的所有合法来源点
export function legalFromPoints(pos: Position, die: number): number[] {
  const res: number[] = [];
  for (let p = 1; p <= 6; p++) {
    if (pos.points[p] <= 0) continue;
    if (die < p || canBearOffFrom(pos, p, die)) res.push(p);
  }
  return res;
}

export interface PathInfo {
  moves: Move[];
  finalPosition: Position;
  usedDice: number[];
  unusedDice: number[];
  unusedReason: string;
}

export interface EnumerateResult {
  complete: boolean; // 枚举预算内是否找全
  maxDiceUsed: number;
  paths: PathInfo[];
  nodeCount: number;
}

function pathKey(moves: Move[]): string {
  return moves.map((m) => `${m.from}:${m.die}`).join("|");
}

// 枚举完整用骰路径，并按“最大用骰数 + 大骰优先”筛选
export function enumeratePaths(
  start: Position,
  die1: number,
  die2: number,
  budget: number = DEFAULT_ENUM_BUDGET,
): EnumerateResult {
  const dicePool: number[] =
    die1 === die2 ? [die1, die1, die1, die1] : [die1, die2];
  const raw: Move[][] = [];
  let nodes = 0;
  let complete = true;

  function rec(pos: Position, remaining: number[], moves: Move[]): void {
    if (!complete) return;
    if (++nodes > budget) {
      complete = false;
      return;
    }
    if (checkersOnBoard(pos) === 0 || remaining.length === 0) {
      raw.push(moves);
      return;
    }
    // 相同骰点只展开一次，避免同值骰子产生重复路径
    const uniqueDice = [...new Set(remaining)];
    let anyLegal = false;
    for (const d of uniqueDice) {
      for (const from of legalFromPoints(pos, d)) {
        anyLegal = true;
        const next = applyMove(pos, from, d);
        const rest = remaining.slice();
        rest.splice(rest.indexOf(d), 1);
        rec(next, rest, [...moves, { from, die: d, bearOff: d >= from }]);
        if (!complete) return;
      }
    }
    if (!anyLegal) raw.push(moves);
  }

  rec(clonePosition(start), dicePool, []);

  // 去重（相同棋子身份交换不产生新路径）
  const seen = new Set<string>();
  const deduped: Move[][] = [];
  for (const p of raw) {
    const k = pathKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(p);
    }
  }

  // 筛选一：保留使用骰子次数最多者（对所有候选生效，包括较早离盘完毕的路径）
  let maxUsed = 0;
  for (const p of deduped) maxUsed = Math.max(maxUsed, p.length);
  let filtered = deduped.filter((p) => p.length === maxUsed);

  // 筛选二：不同骰点各只能用一次时，若只用了一枚骰子且较大骰点也有合法路径，优先较大骰点
  if (die1 !== die2 && maxUsed === 1) {
    const big = Math.max(die1, die2);
    const withBig = filtered.filter((p) => p[0].die === big);
    if (withBig.length > 0) filtered = withBig;
  }

  const paths: PathInfo[] = filtered.map((moves) => {
    let pos = clonePosition(start);
    const used: number[] = [];
    for (const m of moves) {
      pos = applyMove(pos, m.from, m.die);
      used.push(m.die);
    }
    const unused = dicePool.slice();
    for (const d of used) unused.splice(unused.indexOf(d), 1);
    let unusedReason = "";
    if (unused.length > 0) {
      unusedReason =
        checkersOnBoard(pos) === 0
          ? "所有棋子已离盘，剩余骰子无棋子可用"
          : "剩余骰子在当前局面下没有合法移动";
    }
    return { moves, finalPosition: pos, usedDice: used, unusedDice: unused, unusedReason };
  });

  return { complete, maxDiceUsed: maxUsed, paths, nodeCount: nodes };
}

// 模拟一条提交路径：逐步核验局部合法性并消耗骰子
export function simulatePath(
  start: Position,
  die1: number,
  die2: number,
  moves: { from: number; die: number }[],
): { positions: Position[]; used: number[]; unused: number[] } {
  const pool: number[] =
    die1 === die2 ? [die1, die1, die1, die1] : [die1, die2];
  const positions: Position[] = [];
  const used: number[] = [];
  let pos = clonePosition(start);
  for (const m of moves) {
    const idx = pool.indexOf(m.die);
    if (idx < 0) {
      throw new RuleError("DIE_NOT_AVAILABLE", `骰点 ${m.die} 本回合已不可用`);
    }
    pos = applyMove(pos, m.from, m.die);
    pool.splice(idx, 1);
    used.push(m.die);
    positions.push(clonePosition(pos));
  }
  return { positions, used, unused: pool };
}

// 核验整条提交路径：局部合法 + 最大用骰 + 大骰优先
export function verifySubmittedPath(
  start: Position,
  die1: number,
  die2: number,
  moves: { from: number; die: number }[],
  budget: number,
): { finalPosition: Position; usedDice: number[]; unusedDice: number[]; unusedReason: string } {
  validateDice(die1, die2);
  if (!Array.isArray(moves) || moves.length === 0) {
    throw new RuleError("EMPTY_PATH", "提交路径为空");
  }
  for (const m of moves) {
    if (
      typeof m !== "object" ||
      m === null ||
      !Number.isInteger(m.from) ||
      !Number.isInteger(m.die)
    ) {
      throw new RuleError("INVALID_MOVE", "路径每步必须包含整数 from 与 die");
    }
  }
  const sim = simulatePath(start, die1, die2, moves);
  const finalPos = sim.positions[sim.positions.length - 1];

  // 局部最大性：路径结束后若仍有可用骰子且盘上还有棋子，则只是合法前缀
  if (checkersOnBoard(finalPos) > 0) {
    for (const d of new Set(sim.unused)) {
      if (legalFromPoints(finalPos, d).length > 0) {
        throw new RuleError(
          "NOT_MAXIMAL",
          `路径只是合法前缀：结束后骰点 ${d} 仍有合法移动`,
        );
      }
    }
  }

  const en = enumeratePaths(start, die1, die2, budget);
  if (!en.complete) {
    throw new RuleError(
      "PATH_SET_INCOMPLETE",
      "枚举预算不足，无法确认该路径满足最大用骰规则；请提高预算后重试",
    );
  }
  if (moves.length < en.maxDiceUsed) {
    throw new RuleError(
      "NOT_MAX_DICE",
      `本回合最多可使用 ${en.maxDiceUsed} 次骰子，提交路径只用了 ${moves.length} 次`,
    );
  }
  const key = moves.map((m) => `${m.from}:${m.die}`).join("|");
  const ok = en.paths.some(
    (p) => p.moves.map((m) => `${m.from}:${m.die}`).join("|") === key,
  );
  if (!ok) {
    throw new RuleError(
      "PATH_NOT_OPTIMAL",
      "路径不满足本回合最大用骰及大骰优先规则",
    );
  }
  let unusedReason = "";
  if (sim.unused.length > 0) {
    unusedReason =
      checkersOnBoard(finalPos) === 0
        ? "所有棋子已离盘，剩余骰子无棋子可用"
        : "剩余骰子在当前局面下没有合法移动";
  }
  return {
    finalPosition: finalPos,
    usedDice: sim.used,
    unusedDice: sim.unused,
    unusedReason,
  };
}
