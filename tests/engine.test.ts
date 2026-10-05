import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFromPoints } from "../src/engine/rules.ts";
import { enumeratePaths } from "../src/engine/enumerate.ts";
import { canMove } from "../src/engine/rules.ts";
import { validatePath } from "../src/engine/validate.ts";

const P = (arr: number[]) =>
  [arr[0]!, arr[1]!, arr[2]!, arr[3]!, arr[4]!, arr[5]!] as const;

function keys(result: ReturnType<typeof enumeratePaths>) {
  return result.paths.map((p) => p.moves.map((m) => `${m.p}:${m.d}`).join(","));
}

test("超点离盘被更远点阻止", () => {
  // p2 一子，p6 一子。骰 3 在 p2 应被 p6 阻止。
  const points = P([0, 1, 0, 0, 0, 1]);
  assert.equal(canMove(points, 2, 3), false);
  // p6 清空后，p2 用 3 可超点离盘
  const onlyP2 = P([0, 1, 0, 0, 0, 0]);
  assert.equal(canMove(onlyP2, 2, 3), true);
});

test("手算小残局：p2+p6，骰 3,5 的规范路径集合", () => {
  // 总棋子 2。
  // 首步 5：只能 p6 用 5 -> p1（p6-5=p1）。更新后 p1=1,p2=1，剩骰 3。
  //   3 在更新后盘面：p2->离盘(=3? p2<3 超点，p3..p6空 => 离盘)。
  //   路径A: 6:5,2:3 用2颗。之后 p1 剩一子，无骰 => 止。
  // 首步 3：p6 用 3 -> p3；p2 用 3 被 p6 阻止（首步时 p6 有子）。
  //   更新后 p3=1,p2=1，剩骰 5：p3 用5(p<5,更远 p4..6空)离盘；p2 用5超点离盘(更远空)。
  //   这些路径用2颗。但大骰5在初盘合法(p6)，受限大骰优先 -> 只保留首步5的路径。
  const result = enumeratePaths(boardFromPoints(P([0, 1, 0, 0, 0, 1]), 0), 3, 5, 100000);
  assert.equal(result.complete, true);
  assert.equal(result.maxUsedCount, 2);
  assert.deepEqual(keys(result), [["6:5", "2:3"].join(",")]);
  // 移动最高点后 p2 离盘，验证终态
  const path = result.paths[0]!;
  assert.equal(path.moves[0]!.borneOff, false);
  assert.equal(path.moves[0]!.toP, 1);
  assert.equal(path.moves[1]!.borneOff, true);
  assert.deepEqual([...path.end.points], [1, 0, 0, 0, 0, 0]);
  assert.equal(path.end.borneOff, 1);
});

test("交换骰子顺序产生不同后续（p4,p5 骰2,3）", () => {
  // 先走2：p4->p2 或 p5->p3；先走3：p4->p1 或 p5->p2。
  // 大骰3在初盘合法 => 大骰优先，只留首步3。枚举可推出不同路径。
  const result = enumeratePaths(boardFromPoints(P([0, 0, 0, 1, 1, 0]), 0), 2, 3, 100000);
  const ks = keys(result);
  // 首步全部为 3
  assert.ok(ks.every((k) => k.startsWith("4:3") || k.startsWith("5:3")));
  // 两条分支不同：p4用3 与 p5用3
  const firstSteps = new Set(ks.map((k) => k.split(",")[0]));
  assert.equal(firstSteps.size, 2);
});

test("双幺连续使用四次", () => {
  const result = enumeratePaths(boardFromPoints(P([4, 0, 0, 0, 0, 0]), 0), 1, 1, 100000);
  assert.equal(result.maxUsedCount, 4);
  assert.equal(result.paths.length, 1);
  const path = result.paths[0]!;
  assert.equal(path.cleared, true);
  assert.equal(path.end.borneOff, 4);
  assert.deepEqual([...path.end.points], [0, 0, 0, 0, 0, 0]);
});

test("只剩一颗棋子", () => {
  // p3 一子，骰 6,2。大骰6可超点离盘(更远空) => 大骰优先：首步6离盘，用1颗清空。
  const result = enumeratePaths(boardFromPoints(P([0, 0, 1, 0, 0, 0]), 0), 6, 2, 100000);
  assert.deepEqual(keys(result), ["3:6"]);
  assert.equal(result.paths[0]!.unused[0]!.reason, "no_checkers");
});

test("全部已离盘：无路径、无可用骰", () => {
  const result = enumeratePaths(boardFromPoints(P([0, 0, 0, 0, 0, 0]), 4), 1, 2, 100000);
  assert.equal(result.paths.length, 1);
  assert.equal(result.paths[0]!.usedCount, 0);
  assert.deepEqual(
    result.paths[0]!.unused.map((u) => u.reason),
    ["no_checkers", "no_checkers"],
  );
});

test("空点移动被核验拒绝", () => {
  const v = validatePath(
    boardFromPoints(P([0, 0, 1, 0, 0, 0]), 0),
    3,
    5,
    [{ p: 1, d: 3 }],
    1,
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.errorCode, "ILLEGAL_MOVE");
});

test("只提交合法前缀被拒绝", () => {
  // p1 四颗双幺，必须用满 4 次；只交 2 步是合法前缀但非最大。
  const start = boardFromPoints(P([4, 0, 0, 0, 0, 0]), 0);
  const prefix = validatePath(start, 1, 1, [{ p: 1, d: 1 }, { p: 1, d: 1 }], 4);
  assert.equal(prefix.ok, false);
  if (!prefix.ok) assert.equal(prefix.errorCode, "NOT_MAXIMAL");

  const full = validatePath(
    start,
    1,
    1,
    [1, 2, 3, 4].map(() => ({ p: 1, d: 1 })),
    4,
  );
  assert.equal(full.ok, true);
});

test("大骰优先：首步用小骰被拒绝", () => {
  const start = boardFromPoints(P([0, 1, 0, 0, 0, 1]), 0);
  // 首步 3（小骰）虽局部合法（p6->p3），但大骰5在初盘合法，须首步5。
  const v = validatePath(start, 3, 5, [{ p: 6, d: 3 }], 2);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.errorCode, /LARGE_DIE|NOT_MAXIMAL/);
});

test("骰子超出可用次数被拒绝", () => {
  const start = boardFromPoints(P([4, 0, 0, 0, 0, 0]), 0);
  const v = validatePath(
    start,
    1,
    2,
    [1, 2].map(() => ({ p: 1, d: 1 })),
    4,
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.errorCode, "DIE_NOT_AVAILABLE");
});

test("每条路径盘内+离盘守恒", () => {
  const starts: { arr: number[]; off: number; dice: [number, number] }[] = [
    { arr: [0, 1, 0, 0, 0, 1], off: 0, dice: [3, 5] },
    { arr: [0, 0, 0, 1, 1, 0], off: 3, dice: [2, 3] },
    { arr: [2, 1, 3, 0, 1, 1], off: 7, dice: [4, 6] },
  ];
  for (const s of starts) {
    const total = s.arr.reduce((a, b) => a + b, 0) + s.off;
    const board = boardFromPoints(P(s.arr), s.off);
    const r = enumeratePaths(board, s.dice[0], s.dice[1], 100000);
    for (const path of r.paths) {
      const on = [...path.end.points].reduce((a, b) => a + b, 0);
      assert.equal(on + path.end.borneOff, total);
      for (const m of path.moves) {
        const beforeOn = [...m.before].reduce((a, b) => a + b, 0);
        const afterOn = [...m.after].reduce((a, b) => a + b, 0);
        assert.equal(beforeOn + m.borneOffBefore, afterOn + m.borneOffAfter);
      }
    }
  }
});

test("枚举预算不足标记未完成", () => {
  const board = boardFromPoints(P([5, 5, 5, 0, 0, 0]), 0);
  const r = enumeratePaths(board, 1, 1, 3);
  assert.equal(r.complete, false);
});

test("相同棋子身份交换不产生重复", () => {
  // p1 多子双幺只有一条路径（来源点相同）。
  const r = enumeratePaths(boardFromPoints(P([3, 0, 0, 0, 0, 0]), 0), 1, 1, 100000);
  assert.equal(r.paths.length, 1);
});
