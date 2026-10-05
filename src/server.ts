// HTTP API：创建残局、输入骰点、列路径、解释一步、提交路径、查询回合、导出
import * as http from "node:http";
import { Store, defaultDbPath } from "./store.js";
import { RuleError, explainStep, Position } from "./rules.js";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof RuleError) {
    send(res, 400, { error: { code: e.code, message: e.message } });
  } else {
    send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuleError("BAD_JSON", "请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      // POST /games
      if (method === "POST" && parts.length === 1 && parts[0] === "games") {
        const body = await readBody(req);
        const game = store.createGame(body);
        send(res, 201, { game });
        return;
      }

      if (parts[0] === "games" && parts.length >= 2) {
        const gameId = Number(parts[1]);
        if (!Number.isInteger(gameId)) {
          throw new RuleError("BAD_ID", "对局 id 必须是整数");
        }
        // GET /games/:id
        if (method === "GET" && parts.length === 2) {
          send(res, 200, { game: store.getGame(gameId) });
          return;
        }
        // GET /games/:id/export
        if (method === "GET" && parts.length === 3 && parts[2] === "export") {
          const game = store.getGame(gameId);
          const turns = store.listTurns(gameId);
          send(res, 200, { game, turns });
          return;
        }
        // GET /games/:id/replay
        if (method === "GET" && parts.length === 3 && parts[2] === "replay") {
          send(res, 200, store.replay(gameId));
          return;
        }
        // POST /games/:id/turns  {die1, die2}
        if (method === "POST" && parts.length === 3 && parts[2] === "turns") {
          const body = await readBody(req);
          const { turn, en } = store.createTurn(gameId, body.die1, body.die2);
          send(res, 201, {
            turn,
            complete: en.complete,
            pathCount: en.paths.length,
            maxDiceUsed: en.maxDiceUsed,
          });
          return;
        }
        if (parts[2] === "turns" && parts.length >= 4) {
          const turnNo = Number(parts[3]);
          if (!Number.isInteger(turnNo)) {
            throw new RuleError("BAD_TURN", "回合号必须是整数");
          }
          // GET /games/:id/turns/:n
          if (method === "GET" && parts.length === 4) {
            send(res, 200, { turn: store.getTurn(gameId, turnNo) });
            return;
          }
          // GET /games/:id/turns/:n/paths
          if (method === "GET" && parts.length === 5 && parts[4] === "paths") {
            const turn = store.getTurn(gameId, turnNo);
            send(res, 200, {
              complete: turn.complete === 1,
              paths: JSON.parse(turn.paths_json),
            });
            return;
          }
          // POST /games/:id/turns/:n/explain {from, die}
          if (method === "POST" && parts.length === 5 && parts[4] === "explain") {
            const body = await readBody(req);
            const turn = store.getTurn(gameId, turnNo);
            const start = JSON.parse(turn.start_json) as Position;
            send(res, 200, explainStep(start, Number(body.from), Number(body.die)));
            return;
          }
          // POST /games/:id/turns/:n/submit {path:[{from,die},...]}
          if (method === "POST" && parts.length === 5 && parts[4] === "submit") {
            const body = await readBody(req);
            const { turn, result } = store.submitPath(gameId, turnNo, body.path);
            send(res, 200, { turn, result });
            return;
          }
        }
      }
      throw new RuleError("NOT_FOUND", `未知路由 ${method} ${url.pathname}`);
    } catch (e) {
      sendError(res, e);
    }
  });
}

export async function startServer(
  dbPath: string = defaultDbPath(),
  port: number = 0,
): Promise<{ server: http.Server; port: number; store: Store }> {
  const store = new Store(dbPath);
  const server = createServer(store);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return { server, port: actualPort, store };
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const portEnv = process.env.PORT ? Number(process.env.PORT) : 0;
  const dbPath = process.env.DB_PATH ?? defaultDbPath();
  startServer(dbPath, portEnv).then(({ port }) => {
    console.log(`六点残局服务已启动: http://127.0.0.1:${port}  (数据库: ${dbPath})`);
  });
}
