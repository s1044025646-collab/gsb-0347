// CLI：六点数量表展示中间状态
import { Store, defaultDbPath } from "./store.js";
import { Position, PathInfo, explainStep } from "./rules.js";

function renderPosition(pos: Position): string {
  const lines = ["点号:   1   2   3   4   5   6"];
  const counts: string[] = [];
  for (let p = 1; p <= 6; p++) counts.push(String(pos.points[p]).padStart(3));
  lines.push("棋子: " + counts.join(" "));
  lines.push(`已离盘: ${pos.borneOff}`);
  return lines.join("\n");
}

function renderPath(p: PathInfo, idx: number): string {
  const steps = p.moves
    .map((m, i) => `    ${i + 1}. 从 ${m.from} 点用骰 ${m.die}${m.bearOff ? "（离盘）" : ""}`)
    .join("\n");
  const unused =
    p.unusedDice.length > 0
      ? `  未用骰子: [${p.unusedDice.join(", ")}] — ${p.unusedReason}`
      : "  未用骰子: 无";
  const final = renderPosition(p.finalPosition)
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
  return `路径 ${idx + 1}:\n${steps}\n${unused}\n  终态:\n${final}`;
}

function dbPathFrom(args: string[]): string {
  const i = args.indexOf("--db");
  return i >= 0 ? args[i + 1] : defaultDbPath();
}

function fail(e: unknown): never {
  if (e && typeof e === "object" && "code" in e) {
    const err = e as { code: string; message: string };
    console.error(`错误 [${err.code}] ${err.message}`);
  } else {
    console.error(String(e));
  }
  process.exit(1);
}

const USAGE = [
  "用法: node dist/src/cli.js <命令> [参数] [--db 路径]",
  "  create '<json>'            创建残局",
  "  dice <gameId> <d1> <d2>    输入骰点并枚举路径",
  "  paths <gameId> <turn>      列出合法完整路径",
  "  explain <gameId> <turn> <from> <die>   解释某一步",
  "  submit <gameId> <turn> '<json>'        提交路径",
  "  show <gameId> [turn]       查询对局/回合",
  "  export <gameId>            导出 JSON",
  "  replay <gameId>            按旧骰点重放已提交路径",
  "",
].join("\n");

export function runCli(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const store = new Store(dbPathFrom(argv));
  try {
    switch (cmd) {
      case "create": {
        const body = JSON.parse(rest[0]);
        const game = store.createGame(body);
        console.log(`对局 ${game.id} 已创建（规则 ${game.rules_version}，预算 ${game.enum_budget}）`);
        console.log(renderPosition(JSON.parse(game.current_json)));
        break;
      }
      case "dice": {
        const [gid, d1, d2] = rest.map(Number);
        const { turn, en } = store.createTurn(gid, d1, d2);
        const suffix = en.complete ? "" : "（枚举预算不足，结果未完成）";
        console.log(`回合 ${turn.turn_no}：骰子 ${d1},${d2}，共 ${en.paths.length} 条规范路径${suffix}`);
        console.log("回合开始局面:");
        console.log(renderPosition(JSON.parse(turn.start_json)));
        break;
      }
      case "paths": {
        const [gid, tno] = rest.map(Number);
        const turn = store.getTurn(gid, tno);
        const paths = JSON.parse(turn.paths_json) as PathInfo[];
        if (turn.complete !== 1) console.log("警告：枚举未完成，路径列表可能不完整");
        paths.forEach((p, i) => console.log(renderPath(p, i) + "\n"));
        break;
      }
      case "explain": {
        const [gid, tno, from, die] = rest.map(Number);
        const turn = store.getTurn(gid, tno);
        const r = explainStep(JSON.parse(turn.start_json), from, die);
        if (!r.ok) {
          console.log(`不合法 [${r.code}] ${r.reason}`);
        } else {
          console.log(`合法：从 ${from} 用骰 ${die}${r.move!.bearOff ? "（离盘）" : ""}`);
          console.log("前:\n" + renderPosition(r.before!));
          console.log("后:\n" + renderPosition(r.after!));
        }
        break;
      }
      case "submit": {
        const [gid, tno] = rest.map(Number);
        const path = JSON.parse(rest[2]);
        const { result } = store.submitPath(gid, tno, path);
        const r = result as { finalPosition: Position; unusedDice: number[]; unusedReason: string };
        console.log("提交成功，终态:");
        console.log(renderPosition(r.finalPosition));
        if (r.unusedDice.length > 0) {
          console.log(`未用骰子: [${r.unusedDice.join(", ")}] — ${r.unusedReason}`);
        }
        break;
      }
      case "show": {
        const gid = Number(rest[0]);
        const game = store.getGame(gid);
        console.log(`对局 ${game.id} 下一回合号 ${game.next_turn} 当前局面:`);
        console.log(renderPosition(JSON.parse(game.current_json)));
        if (rest[1] !== undefined) {
          const turn = store.getTurn(gid, Number(rest[1]));
          console.log(`回合 ${turn.turn_no}: 骰子 ${turn.die1},${turn.die2} 状态 ${turn.status}`);
        }
        break;
      }
      case "export": {
        const gid = Number(rest[0]);
        console.log(
          JSON.stringify({ game: store.getGame(gid), turns: store.listTurns(gid) }, null, 2),
        );
        break;
      }
      case "replay": {
        const gid = Number(rest[0]);
        const r = store.replay(gid);
        console.log(`重放 ${r.turns} 个已提交回合，终态:`);
        console.log(renderPosition(r.finalPosition));
        break;
      }
      default:
        process.stdout.write(USAGE);
        if (cmd) process.exitCode = 1;
    }
  } catch (e) {
    fail(e);
  } finally {
    store.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
  runCli(process.argv.slice(2));
}
