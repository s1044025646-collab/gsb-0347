/**
 * 双陆棋单方六点离盘残局 —— 核心类型。
 *
 * 本文件只描述“本方内盘”的六个点，不包含对手、击打、受罚栏等全局概念。
 * points[i] 表示距离离盘 (i+1) 步的点上棋子数量，i=0 即一点（最近），i=5 即六点（最远）。
 */

export const NUM_POINTS = 6;

/** 固定规则版本，落盘并随导出返回。 */
export const RULES_VERSION = "bg6-bearoff-v1";

/** 六点数量，按“距离离盘 1..6 步”顺序排列。元素必须为非负整数。 */
export type Points = readonly [number, number, number, number, number, number];

/** 一个完整盘面：六个点 + 已离盘数量。 */
export interface Board {
  /** points[i] 为距离盘 i+1 步的点上棋子数。 */
  points: Points;
  /** 已离盘棋子数量。 */
  borneOff: number;
}

/** 一颗骰子的点数（1..6）。 */
export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * 一步移动。
 * - p 为来源点（距离盘 1..6 步）。
 * - d 为本步实际使用的骰点。
 * - borneOff 为 true 表示该枚棋子本步离盘（精确离盘或超点离盘）。
 * - toP 为目的点；离盘时为 null。
 */
export interface Move {
  p: number;
  d: number;
  borneOff: boolean;
  toP: number | null;
}

/** 移动前后数量快照，用于解释某一步。 */
export interface MoveDetail extends Move {
  before: Points;
  after: Points;
  borneOffBefore: number;
  borneOffAfter: number;
}

/** 未使用骰点及原因。 */
export interface UnusedDie {
  d: number;
  reason: "no_checkers" | "no_legal_move";
}

/** 一条完整用骰路径。 */
export interface PathResult {
  /** 依次执行的移动。 */
  moves: MoveDetail[];
  /** 路径终点盘面。 */
  end: Board;
  /** 未使用的骰点及原因。 */
  unused: UnusedDie[];
  /** 使用骰点次数。 */
  usedCount: number;
  /** 是否本路径已经清空所有盘内棋子。 */
  cleared: boolean;
}

/** 枚举结果。complete=false 表示命中枚举预算，路径集合可能不完整。 */
export interface EnumerationResult {
  paths: PathResult[];
  /** 所有已保留候选中最大的用骰次数。 */
  maxUsedCount: number;
  /** 是否搜索完整（未被预算截断）。 */
  complete: boolean;
  /** 实际展开的状态节点数（预算计量单位）。 */
  nodesExpanded: number;
  /** 配置的枚举预算。 */
  budget: number;
}

export interface RuleConfig {
  /** 总棋子数约束（盘内 + 离盘 必须等于该值）。 */
  totalCheckers: number;
  /** 枚举预算（状态节点展开数上限）。 */
  budget: number;
}
