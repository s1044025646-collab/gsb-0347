// 演示：最高点阻止超点离盘、移走最高点后允许、换序不同后续、双骰四次
import { enumeratePaths, explainStep, Position } from "./rules.js";

function show(title: string, pos: Position, d1: number, d2: number): void {
  console.log("=".repeat(60));
  console.log(title);
  console.log(`局面: [${pos.points.slice(1).join(", ")}] 已离盘 ${pos.borneOff}，骰子 ${d1},${d2}`);
  const en = enumeratePaths(pos, d1, d2);
  console.log(`规范路径 ${en.paths.length} 条（最多用骰 ${en.maxDiceUsed} 次）:`);
  en.paths.forEach((p, i) => {
    const s = p.moves
      .map((m) => `${m.from}点用${m.die}${m.bearOff ? "(离盘)" : ""}`)
      .join(" -> ");
    const un = p.unusedDice.length ? `  未用[${p.unusedDice}] ${p.unusedReason}` : "";
    console.log(`  ${i + 1}. ${s || "(无移动)"}${un}`);
  });
}

const P = (a: number[]): Position => ({ points: [0, ...a], borneOff: 0 });

console.log("演示 1：最高点阻止较低点超点离盘");
const blocked = P([0, 0, 1, 0, 0, 1]);
const bad = explainStep(blocked, 3, 5);
console.log(`explain(3点, 骰5): ok=${bad.ok} code=${bad.code} 原因=${bad.reason}`);
show("3 点不能用 5 超点离盘（6 点有子）", blocked, 5, 2);

console.log("\n演示 2：先移走最高点后允许超点离盘");
show("同上局面，路径 [6点用2, 4点用5(离盘)] 合法", blocked, 5, 2);

console.log("\n演示 3：交换两枚骰子顺序产生不同后续");
show("6 点与 3 点各一子，骰子 6,1", P([0, 0, 1, 0, 0, 1]), 6, 1);

console.log("\n演示 4：双骰连续使用四次");
show("4 点两子，双 2", P([0, 0, 0, 2, 0, 0]), 2, 2);
