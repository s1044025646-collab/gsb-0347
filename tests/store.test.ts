import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { BackgammonService, ServiceError } from "../src/service.ts";
import { Store } from "../src/db/store.ts";

function tempService(): { service: BackgammonService; dbPath: string } {
  const dir = join(tmpdir(), `bg6-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "t.db");
  return { service: new BackgammonService(new Store(dbPath)), dbPath };
}

test("创建残局参数校验", () => {
  const { service } = tempService();
  assert.throws(() => service.createGame({ points: [1, 0] }), (e: Error) =>
    (e as ServiceError).errorCode === "INVALID_POINTS",
  );
  assert.throws(() => service.createGame({ points: [-1, 0, 0, 0, 0, 0], totalCheckers: 1 }), (e: Error) =>
    (e as ServiceError).errorCode === "INVALID_POINTS",
  );
  assert.throws(
    () => service.createGame({ points: [10, 0, 0, 0, 0, 0], totalCheckers: 5 }),
    (e: Error) => (e as ServiceError).errorCode === "TOTAL_EXCEEDED",
  );
});

test("提交失败不移动棋子，且可重试；成功后进入下一回合", () => {
  const { service } = tempService();
  const game = service.createGame({ points: [4, 0, 0, 0, 0, 0], totalCheckers: 4 });
  const { turnId } = service.rollDice(game.id, 1, 1);

  // 非法提交（只用两颗，前缀）应被拒且回合仍 pending、盘面不变。
  assert.throws(
    () => service.submitPath(turnId, [{ p: 1, d: 1 }, { p: 1, d: 1 }]),
    (e: Error) => (e as ServiceError).errorCode === "NOT_MAXIMAL",
  );
  const turnAfterFail = service.getTurn(turnId);
  assert.equal(turnAfterFail.status, "pending");
  assert.equal(turnAfterFail.end, null);

  // 重新完整提交成功。
  const steps = [1, 2, 3, 4].map(() => ({ p: 1, d: 1 }));
  service.submitPath(turnId, steps);
  const view = service.getGame(game.id);
  assert.equal(view.board.borneOff, 4);

  // 下一回合从清空后的盘面开始。
  const next = service.rollDice(game.id, 2, 4);
  assert.deepEqual([...next.board.points], [0, 0, 0, 0, 0, 0]);
});

test("过期回合号被拒绝", () => {
  const { service } = tempService();
  const game = service.createGame({ points: [4, 0, 0, 0, 0, 0], totalCheckers: 4 });
  const t1 = service.rollDice(game.id, 1, 1);
  service.submitPath(t1.turnId, [1, 2, 3, 4].map(() => ({ p: 1, d: 1 })));
  const t2 = service.rollDice(game.id, 2, 3);
  assert.equal(t2.turnId, t1.turnId + 1);
  // 向旧回合提交 => 过期
  assert.throws(() => service.submitPath(t1.turnId, []), (e: Error) =>
    (e as ServiceError).errorCode === "TURN_EXPIRED",
  );
  // 乐观锁回合号不符 => 过期
  assert.throws(() => service.submitPath(t2.turnId, [], 999), (e: Error) =>
    (e as ServiceError).errorCode === "TURN_EXPIRED",
  );
});

test("相同输入确定性 + 重启后重放", () => {
  const { service, dbPath } = tempService();
  const game = service.createGame({ points: [0, 1, 0, 0, 0, 1], totalCheckers: 2 });
  const { turnId } = service.rollDice(game.id, 3, 5);
  const pathsFirst = service.listPaths(turnId).enumeration!.pathCount;
  const pathsSecond = service.listPaths(turnId).enumeration!.pathCount;
  assert.equal(pathsFirst, pathsSecond);

  service.submitPath(turnId, [
    { p: 6, d: 5 },
    { p: 2, d: 3 },
  ]);

  // 用同一数据库文件“重启”
  const reopened = new BackgammonService(new Store(dbPath));
  const replay = reopened.replayTurn(turnId);
  assert.deepEqual(replay.replayed, [
    { p: 6, d: 5 },
    { p: 2, d: 3 },
  ]);
  assert.equal(replay.turn.end!.borneOff, 1);
  assert.deepEqual([...replay.turn.end!.points], [1, 0, 0, 0, 0, 0]);
});

test("内存数据库也能直接运行（DatabaseSync 注入）", () => {
  const service = new BackgammonService(new Store(new DatabaseSync(":memory:")));
  const game = service.createGame({ points: [1, 0, 0, 0, 0, 0], totalCheckers: 1 });
  const { turnId } = service.rollDice(game.id, 1, 1);
  const view = service.listPaths(turnId);
  assert.equal(view.enumeration!.maxUsedCount, 1);
});
