import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.js";
import { startServer } from "../src/server.js";
import { RuleError } from "../src/rules.js";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sixpoint-")), "t.db");
}

test("提交失败不改变数据；过期回合号拒绝；重启后重放一致", () => {
  const db = tmpDb();
  let store = new Store(db);
  const game = store.createGame({ points: [0, 0, 0, 0, 0, 2], borneOff: 13 });
  const gid = game.id;
  store.createTurn(gid, 3, 4);

  assert.throws(() => store.submitPath(gid, 1, [{ from: 5, die: 3 }]));
  let g = store.getGame(gid);
  assert.deepEqual(JSON.parse(g.current_json).points, [0, 0, 0, 0, 0, 0, 2]);
  assert.equal(store.getTurn(gid, 1).status, "open");

  store.submitPath(gid, 1, [
    { from: 6, die: 3 },
    { from: 6, die: 4 },
  ]);
  g = store.getGame(gid);
  assert.deepEqual(JSON.parse(g.current_json).points, [0, 0, 1, 1, 0, 0, 0]);

  assert.throws(
    () => store.submitPath(gid, 1, [{ from: 6, die: 3 }]),
    (e: unknown) => (e as RuleError).code === "TURN_ALREADY_SUBMITTED",
  );

  store.close();
  store = new Store(db);
  g = store.getGame(gid);
  assert.equal(g.next_turn, 2);
  store.createTurn(gid, 6, 6);
  store.submitPath(gid, 2, [
    { from: 3, die: 6 },
    { from: 2, die: 6 },
  ]);
  const replay = store.replay(gid);
  assert.equal(replay.turns, 2);
  assert.equal(replay.finalPosition.borneOff, 15);
  assert.deepEqual(replay.finalPosition, JSON.parse(store.getGame(gid).current_json));
  store.close();
});

test("HTTP API 全流程", async () => {
  const { server, port, store } = await startServer(tmpDb(), 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const post = async (p: string, body: unknown) => {
      const r = await fetch(base + p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: await r.json() };
    };

    const bad = await post("/games", { points: [0, 0, -1, 0, 0, 0], borneOff: 0 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "NEGATIVE_COUNT");

    const g = await post("/games", { points: [0, 0, 1, 0, 0, 1], borneOff: 13 });
    assert.equal(g.status, 201);
    const gid = g.json.game.id;

    const t = await post(`/games/${gid}/turns`, { die1: 5, die2: 2 });
    assert.equal(t.status, 201);
    assert.equal(t.json.pathCount, 3);

    const paths = await (await fetch(`${base}/games/${gid}/turns/1/paths`)).json();
    assert.equal(paths.paths.length, 3);

    const ex = await post(`/games/${gid}/turns/1/explain`, { from: 3, die: 5 });
    assert.equal(ex.json.ok, false);
    assert.equal(ex.json.code, "BLOCKED_BY_HIGHER");

    const prefix = await post(`/games/${gid}/turns/1/submit`, {
      path: [{ from: 6, die: 5 }],
    });
    assert.equal(prefix.status, 400);
    assert.equal(prefix.json.error.code, "NOT_MAXIMAL");

    const ok = await post(`/games/${gid}/turns/1/submit`, {
      path: [
        { from: 6, die: 2 },
        { from: 4, die: 5 },
      ],
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.result.finalPosition.borneOff, 14);

    const exp = await (await fetch(`${base}/games/${gid}/export`)).json();
    assert.equal(exp.turns.length, 1);
    assert.equal(exp.turns[0].status, "submitted");

    const rep = await (await fetch(`${base}/games/${gid}/replay`)).json();
    assert.equal(rep.finalPosition.borneOff, 14);
  } finally {
    server.close();
    store.close();
  }
});
