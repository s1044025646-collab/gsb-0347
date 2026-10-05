#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { Store } from "./db/store.ts";
import { BackgammonService, ServiceError } from "./service.ts";
import type { TurnView } from "./service.ts";
import type { Board, Points } from "./engine/types.ts";
import { startServer } from "./server.ts";
import { enumeratePaths } from "./engine/enumerate.ts";
import { boardFromPoints, canMove, onBoardCount } from "./engine/rules.ts";

const DATA_DIR = resolve(process.cwd(), "data");
const DEFAULT_DB = resolve(DATA_DIR, "bg6.db");

function openService(dbPath = DEFAULT_DB): BackgammonService {
  mkdirSync(DATA_DIR, { recursive: true });
  return new BackgammonService(new Store(dbPath));
}

function renderBoard(board: Board): string {
  const labels = ["一点", "二点", "三点", "四点", "五点", "六点"];
  const lines: string[] = [];
  lines.push("点位        距离  棋子");
  for (let p = 6; p >= 1; p--) {
    lines.push(`${labels[p - 1]!.padEnd(4)} p=${p}    ${board.points[p - 1]!}`);
  }
  lines.push(`已离盘：${board.borneOff}`);
  lines.push(`盘内合计：${onBoardCount(board.points)}`);
  return lines.join("\n");
}

function parsePointsArg(s: string): number[] {
  const parts = s.split(",").map((x) => Number(x.trim()));
  return parts;
}

function printTurn(turn: TurnView): void {
  console.log(`回合 #${turn.turnId}（残局 ${turn.gameId}） 骰子：[${turn.dice.join(", ")}] 状态：${turn.status}`);
  console.log("初态：");
  console.log(renderBoard(turn.start));
  if (turn.end) {
    console.log("终态：");
    console.log(renderBoard(turn.end));
  }
  if (turn.chosenPath) {
    console.log("已选路径：", JSON.stringify(turn.chosenPath));
  }
  if (turn.enumeration) {
    const e = turn.enumeration;
    console.log(
      `枚举：完整=${e.complete} 最多用骰=${e.maxUsedCount} 路径数=${e.pathCount} 节点=${e.nodesExpanded}/${e.budget}`,
    );
    if (!e.complete) {
      console.log("⚠ 预算不足，结果未找全；不会据此拒绝未出现的路径。");
    }
    for (const [i, pathAny] of e.paths.entries()) {
      const path = pathAny as {
        usedCount: number;
        cleared: boolean;
        moves: { p: number; d: number; borneOff: boolean; toP: number | null }[];
        unused: { d: number; reason: string }[];
      };
      console.log(`— 路径 ${i + 1}（用骰 ${path.usedCount}，清空=${path.cleared}）`);
      for (const m of path.moves) {
        console.log(
          `   p${m.p} 用 ${m.d} -> ${m.borneOff ? "离盘" : "到 p" + m.toP}`,
        );
      }
      if (path.unused.length) {
        console.log(
          "   未用骰：" +
            path.unused.map((u) => `${u.d}(${u.reason})`).join(", "),
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const opts = parseOpts(rest);
  try {
    switch (cmd) {
      case "serve": {
        const port = opts.port ? Number(opts.port) : undefined;
        const dbPath = opts.db ?? DEFAULT_DB;
        mkdirSync(DATA_DIR, { recursive: true });
        const running = await startServer(dbPath, port);
        console.log(`双陆棋六点残局后端已启动：http://127.0.0.1:${running.port}`);
        console.log(`数据库：${dbPath}`);
        break;
      }
      case "create": {
        if (!opts.points) throw new ServiceError("INVALID_POINTS", "需要 --points 1,0,...（一点到六点）");
        const service = openService(opts.db);
        const game = service.createGame({
          points: parsePointsArg(opts.points),
          borneOff: opts.off !== undefined ? Number(opts.off) : undefined,
          totalCheckers: opts.total !== undefined ? Number(opts.total) : undefined,
          budget: opts.budget !== undefined ? Number(opts.budget) : undefined,
        });
        console.log(`已创建残局 ${game.id}（规则 ${game.rulesVersion}）`);
        console.log(renderBoard(game.board));
        break;
      }
      case "dice": {
        const service = openService(opts.db);
        const [d1, d2] = (opts.dice ?? "").split(",").map((x) => Number(x));
        const r = service.rollDice(required(opts.game, "--game"), d1!, d2!);
        console.log(`回合 #${r.turnId}，骰子 [${r.d1}, ${r.d2}]`);
        console.log(renderBoard(r.board));
        break;
      }
      case "paths": {
        const service = openService(opts.db);
        printTurn(service.listPaths(Number(required(opts.turn, "--turn"))));
        break;
      }
      case "explain": {
        const service = openService(opts.db);
        const r = service.explainStep(
          Number(required(opts.turn, "--turn")),
          0,
          Number(required(opts.p, "--p")),
          Number(required(opts.d, "--d")),
        );
        console.log(JSON.stringify(r.detail, null, 2));
        break;
      }
      case "submit": {
        const service = openService(opts.db);
        const steps = JSON.parse(required(opts.path, "--path")) as { p: number; d: number }[];
        const turn = service.submitPath(
          Number(required(opts.turn, "--turn")),
          steps,
          opts.expected !== undefined ? Number(opts.expected) : undefined,
        );
        console.log("提交成功：");
        printTurn(turn);
        break;
      }
      case "turn": {
        const service = openService(opts.db);
        console.log(JSON.stringify(service.getTurn(Number(required(opts.turn, "--turn"))), null, 2));
        break;
      }
      case "replay": {
        const service = openService(opts.db);
        const r = service.replayTurn(Number(required(opts.turn, "--turn")));
        console.log(`重放回合 #${r.turn.turnId}：`, JSON.stringify(r.replayed));
        console.log(renderBoard(r.turn.end!));
        break;
      }
      case "export": {
        const service = openService(opts.db);
        console.log(JSON.stringify(service.exportGame(required(opts.game, "--game")), null, 2));
        break;
      }
      case "demo": {
        runDemo();
        break;
      }
      default:
        printHelp();
    }
  } catch (err) {
    if (err instanceof ServiceError) {
      console.error(`错误 [${err.errorCode}]：${err.message}`);
      process.exitCode = 1;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  }
}

function required(v: string | undefined, name: string): string {
  if (v === undefined) throw new ServiceError("MISSING_ARG", `缺少参数 ${name}`);
  return v;
}

function parseOpts(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = "true";
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`bg6 双陆棋六点残局后端（仅 API/CLI）

命令：
  serve  [--port 3000] [--db data/bg6.db]   启动 HTTP 服务（默认自动选空闲端口）
  create --points 1点,..,6点 [--off 0] [--total 15] [--budget 100000]
  dice   --game <id> --dice 3,5
  paths  --turn <id>
  explain --turn <id> --p 6 --d 5
  submit --turn <id> --path '[{"p":6,"d":5}]' [--expected <回合号>]
  turn   --turn <id>
  replay --turn <id>
  export --game <id>
  demo                                      运行内置四组规则演示
`);
}

/** 纯引擎演示，不依赖数据库：覆盖题目要求的四个关键场景。 */
function runDemo(): void {
  const show = (title: string, points: Points, off: number, d1: number, d2: number) => {
    console.log("=".repeat(64));
    console.log(title);
    console.log(renderBoard(boardFromPoints(points, off)));
    const r = enumeratePaths(boardFromPoints(points, off), d1, d2, 100000);
    console.log(`骰子 [${d1},${d2}] 完整=${r.complete} 最多用骰=${r.maxUsedCount} 路径数=${r.paths.length}`);
    r.paths.forEach((path, i) => {
      const seq = path.moves.map((m) => `p${m.p}用${m.d}${m.borneOff ? "离盘" : "→p" + m.toP}`).join("；");
      console.log(`  路径${i + 1}: ${seq || "（无可走步）"}`);
      if (path.unused.length) {
        console.log("    未用：" + path.unused.map((u) => `${u.d}(${u.reason})`).join(", "));
      }
    });
  };

  // 1. 最高点阻止较低点超点离盘：p2 有子、p6 有子，骰 3 想在 p2 超点离盘被 p6 阻止。
  const blocked: Points = [0, 1, 0, 0, 0, 1];
  console.log("=".repeat(64));
  console.log("场景1：最高点 p6 阻止 p2 用骰 3 超点离盘");
  console.log(renderBoard(boardFromPoints(blocked, 0)));
  console.log(`p2 用骰 3 能否超点离盘？ ${canMove(blocked, 2, 3) ? "能" : "不能（更远 p6 仍有棋子）"}`);
  // 2. 先用大骰 5 移动 p6->p1 后，p2 才允许用 3 离盘（枚举给出完整路径）。
  show("场景2：先用大骰移动最高点后，较低点可离盘（受限大骰优先）", blocked, 0, 3, 5);
  // 3. 交换骰子顺序产生不同后续：p4 与 p5，骰 2,3。
  show("场景3：两枚骰子顺序交换产生不同后续", [0, 0, 0, 1, 1, 0], 0, 2, 3);
  // 4. 双骰连续四次：p1 四颗，骰 1,1。
  show("场景4：双幺可连续使用四次，四枚全部离盘", [4, 0, 0, 0, 0, 0], 0, 1, 1);
}

main();
