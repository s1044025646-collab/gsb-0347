import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enumeratePaths,
  verifySubmittedPath,
  validatePosition,
  applyMove,
  Position,
  RuleError,
  checkersOnBoard,
} from "../src/rules.js";
import { FIXTURES } from "../src/fixtures.js";

const P = (a: number[], off = 0): Position => ({ points: [0, ...a], borneOff: off });

function keys(en: ReturnType<typeof enumeratePaths>): string[] {
  return en.paths
    .map((p) => p.moves.map((m) => `${m.from}:${m.die}`).join("|"))
    .sort();
}

test("手列样例：规范路径集合与去重一致", () => {
  for (const f of FIXTURES) {
    const en = enumeratePaths(f.start, f.die1, f.die2);
    assert.ok(en.complete, f.name);
    const expected = f.expectedPaths.map((p) => p.join("|")).sort();
    assert.deepEqual(keys(en), expected, f.name);
  }
});

test("每步前后盘内加离盘数量守恒", () => {
  const en = enumeratePaths(P([1, 1, 1, 1, 1, 1]), 4, 5);
  for (const p of en.paths) {
    const total = checkersOnBoard(p.finalPosition) + p.finalPosition.borneOff;
    assert.equal(total, 6);
  }
});

test("只剩一颗棋子：只能用一个骰子且必须用大骰", () => {
  const en = enumeratePaths(P([1, 0, 0, 0, 0, 0]), 6, 5);
  assert.equal(en.paths.length, 1);
  assert.equal(en.paths[0].moves[0].die, 6);
  assert.equal(en.paths[0].unusedDice.length, 1);
});

test("全已离盘：空路径", () => {
  const en = enumeratePaths(P([0, 0, 0, 0, 0, 0], 15), 3, 4);
  assert.equal(en.paths.length, 1);
  assert.equal(en.paths[0].moves.length, 0);
});

test("空点移动被拒绝", () => {
  assert.throws(() => applyMove(P([0, 0, 0, 0, 0, 1]), 3, 2), /没有棋子/);
});

test("只提交合法前缀被拒绝（NOT_MAXIMAL）", () => {
  const start = P([0, 0, 0, 0, 0, 2]);
  assert.throws(
    () => verifySubmittedPath(start, 3, 4, [{ from: 6, die: 3 }], 100000),
    (e: unknown) => e instanceof RuleError && (e as RuleError).code === "NOT_MAXIMAL",
  );
});

test("提交小骰单步被大骰优先规则拒绝", () => {
  const start = P([1, 0, 0, 0, 0, 0]);
  assert.throws(
    () => verifySubmittedPath(start, 6, 5, [{ from: 1, die: 5 }], 100000),
    (e: unknown) => (e as RuleError).code === "PATH_NOT_OPTIMAL",
  );
});

test("完整合法路径提交成功且未用骰子有原因", () => {
  const start = P([0, 0, 0, 0, 0, 1]);
  const r = verifySubmittedPath(start, 6, 6, [{ from: 6, die: 6 }], 100000);
  assert.equal(r.finalPosition.borneOff, 1);
  assert.equal(r.unusedDice.length, 3);
  assert.match(r.unusedReason, /无棋子可用/);
});

test("非法参数：负数量、非整数、超总数、非法点位、非法骰点", () => {
  assert.throws(
    () => validatePosition([0, 0, -1, 0, 0, 0], 0, 15),
    (e: unknown) => (e as RuleError).code === "NEGATIVE_COUNT",
  );
  assert.throws(
    () => validatePosition([0, 0, 1.5, 0, 0, 0], 0, 15),
    (e: unknown) => (e as RuleError).code === "NON_INTEGER",
  );
  assert.throws(
    () => validatePosition([0, 0, 10, 0, 0, 10], 0, 15),
    (e: unknown) => (e as RuleError).code === "EXCEEDS_TOTAL",
  );
  assert.throws(
    () => applyMove(P([0, 0, 0, 0, 0, 1]), 7, 1),
    (e: unknown) => (e as RuleError).code === "INVALID_POINT",
  );
  assert.throws(
    () => verifySubmittedPath(P([1, 0, 0, 0, 0, 0]), 0, 5, [{ from: 1, die: 5 }], 1000),
    (e: unknown) => (e as RuleError).code === "INVALID_DIE",
  );
});

test("相同输入确定性：两次枚举结果一致", () => {
  const a = keys(enumeratePaths(P([2, 1, 0, 3, 0, 1]), 3, 5));
  const b = keys(enumeratePaths(P([2, 1, 0, 3, 0, 1]), 3, 5));
  assert.deepEqual(a, b);
});

test("枚举预算不足标记未完成，且不据此拒绝路径", () => {
  const en = enumeratePaths(P([1, 1, 1, 1, 1, 1]), 6, 6, 3);
  assert.equal(en.complete, false);
  assert.throws(
    () =>
      verifySubmittedPath(
        P([1, 1, 1, 1, 1, 1]),
        6,
        6,
        [
          { from: 6, die: 6 },
          { from: 5, die: 6 },
          { from: 4, die: 6 },
          { from: 3, die: 6 },
        ],
        3,
      ),
    (e: unknown) => (e as RuleError).code === "PATH_SET_INCOMPLETE",
  );
});
