// 预先手列的小残局独立答案，用于核对规范路径集合与去重
import { Position } from "./rules.js";

export interface Fixture {
  name: string;
  start: Position;
  die1: number;
  die2: number;
  expectedPaths: string[][];
}

function pos(
  p1: number,
  p2: number,
  p3: number,
  p4: number,
  p5: number,
  p6: number,
  off = 0,
): Position {
  return { points: [0, p1, p2, p3, p4, p5, p6], borneOff: off };
}

export const FIXTURES: Fixture[] = [
  {
    // 最高点阻止较低点超点离盘：6 点有子时 3 点不能用 5 离盘
    name: "block-overshoot",
    start: pos(0, 0, 1, 0, 0, 1),
    die1: 5,
    die2: 2,
    expectedPaths: [
      ["6:5", "3:2"],
      ["6:2", "4:5"],
      ["3:2", "6:5"],
    ],
  },
  {
    // 交换两枚骰子顺序产生不同后续
    name: "order-matters",
    start: pos(0, 0, 1, 0, 0, 1),
    die1: 6,
    die2: 1,
    expectedPaths: [
      ["6:6", "3:1"],
      ["6:1", "5:6"],
      ["3:1", "6:6"],
    ],
  },
  {
    // 双骰可连续使用四次；同值骰子去重后只剩一条路径
    name: "double-four-times",
    start: pos(0, 0, 0, 2, 0, 0),
    die1: 2,
    die2: 2,
    expectedPaths: [
      ["4:2", "4:2", "2:2", "2:2"],
      ["4:2", "2:2", "4:2", "2:2"],
    ],
  },
  {
    // 只剩一颗棋子且只能用一个骰子时，优先较大骰点
    name: "larger-die-preferred",
    start: pos(1, 0, 0, 0, 0, 0),
    die1: 6,
    die2: 5,
    expectedPaths: [["1:6"]],
  },
  {
    // 全部已离盘：无可用移动，空路径
    name: "all-borne-off",
    start: pos(0, 0, 0, 0, 0, 0, 15),
    die1: 3,
    die2: 4,
    expectedPaths: [[]],
  },
  {
    // 相同棋子身份交换去重：两个 1 点棋子、双 1
    name: "identity-swap-dedup",
    start: pos(2, 0, 0, 0, 0, 0),
    die1: 1,
    die2: 1,
    expectedPaths: [["1:1", "1:1"]],
  },
];
