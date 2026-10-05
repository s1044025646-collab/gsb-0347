import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { Store } from "./db/store.ts";
import { BackgammonService, ServiceError } from "./service.ts";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: RegExpMatchArray, body: unknown) => Promise<unknown> | unknown;
}

/** 选择一个空闲端口（port=0 时由操作系统分配）。 */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export function createApp(dbPath: string): { server: Server; service: BackgammonService } {
  const store = new Store(dbPath);
  const service = new BackgammonService(store);

  const routes: Route[] = [
    { method: "POST", pattern: /^\/api\/games$/, handler: (_p, b) => service.createGame(b as never) },
    { method: "GET", pattern: /^\/api\/games\/([^/]+)$/, handler: (p) => service.getGame(p[1]!) },
    {
      method: "POST",
      pattern: /^\/api\/games\/([^/]+)\/dice$/,
      handler: (p, b) => {
        const { d1, d2 } = (b ?? {}) as { d1?: number; d2?: number };
        return service.rollDice(p[1]!, d1!, d2!);
      },
    },
    { method: "GET", pattern: /^\/api\/turns\/(\d+)$/, handler: (p) => service.getTurn(Number(p[1])) },
    {
      method: "GET",
      pattern: /^\/api\/turns\/(\d+)\/paths$/,
      handler: (p) => service.listPaths(Number(p[1])),
    },
    {
      method: "GET",
      pattern: /^\/api\/turns\/(\d+)\/explain\/(\d+)\/(\d+)$/,
      handler: (p) => service.explainStep(Number(p[1]), 0, Number(p[2]), Number(p[3])),
    },
    {
      method: "POST",
      pattern: /^\/api\/turns\/(\d+)\/submit$/,
      handler: (p, b) => {
        const body = (b ?? {}) as { steps?: unknown; turn?: number };
        if (!Array.isArray(body.steps)) {
          throw new ServiceError("INVALID_MOVE_SHAPE", "steps 必须为数组");
        }
        return service.submitPath(
          Number(p[1]),
          body.steps as never,
          typeof body.turn === "number" ? body.turn : undefined,
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/turns\/(\d+)\/replay$/,
      handler: (p) => service.replayTurn(Number(p[1])),
    },
    { method: "GET", pattern: /^\/api\/games\/([^/]+)\/export$/, handler: (p) => service.exportGame(p[1]!) },
  ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readJson(req);
      let matched: Route | null = null;
      let params: RegExpMatchArray | null = null;
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = url.pathname.match(route.pattern);
        if (m) {
          matched = route;
          params = m;
          break;
        }
      }
      if (!matched) {
        sendJson(res, 404, { errorCode: "NOT_FOUND", message: "未知接口" });
        return;
      }
      const data = await matched.handler(params!, body);
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      if (err instanceof ServiceError) {
        sendJson(res, err.status, { ok: false, errorCode: err.errorCode, message: err.message });
      } else {
        sendJson(res, 500, {
          ok: false,
          errorCode: "INTERNAL",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  return { server, service };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ServiceError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

export async function startServer(dbPath: string, preferredPort?: number): Promise<{ port: number; close: () => void }> {
  const { server } = createApp(dbPath);
  const port = preferredPort ?? (await pickFreePort());
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as AddressInfo).port;
  return { port: actual, close: () => server.close() };
}
