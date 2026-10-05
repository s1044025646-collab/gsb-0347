# 双陆棋六点残局用骰与离盘路径后端

仅使用 TypeScript + Node.js + SQLite（`node:sqlite`，Node 内置）实现的本地后端，提供 HTTP API 与 CLI。只研究单方六点残局的离盘阶段：保留本方内盘 1..6 六个点的棋子数量与已离盘数量，给定两个骰点，枚举并核验本回合的完整用骰路径。

## 运行环境

- Windows 本地，Node.js ≥ 22.5（建议 ≥ 24，`node:sqlite` 为实验特性，启动时有一条 ExperimentalWarning 属正常）
- 不依赖 Docker、WSL、付费服务或任何外部在线 API；除开发依赖 `typescript` / `@types/node` 外无运行时依赖

## 常用命令

```powershell
npm install        # 安装开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试（node --test）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口并打印）
npm run demo       # 运行四个规则演示场景
```

端口与数据库位置可用环境变量覆盖：`PORT=8080 DB_PATH=data\my.db npm start`。不传 `PORT` 时默认端口 0（操作系统分配空闲端口）。数据目录默认在项目内 `data/`。

## CLI 用法

```powershell
node dist/src/cli.js create '{"points":[0,0,1,0,0,1],"borneOff":13}'
node dist/src/cli.js dice 1 5 2            # 对局 1 开新回合，骰子 5 和 2
node dist/src/cli.js paths 1 1             # 列出回合 1 的规范路径
node dist/src/cli.js explain 1 1 3 5       # 解释“3 点用骰 5”是否合法
node dist/src/cli.js submit 1 1 '[{"from":6,"die":2},{"from":4,"die":5}]'
node dist/src/cli.js show 1                # 六点数量表展示当前局面
node dist/src/cli.js export 1              # 导出 JSON
node dist/src/cli.js replay 1              # 按旧骰点重放已提交路径
```

所有命令支持 `--db <路径>` 指定数据库文件。`points` 是 1..6 点的棋子数量表。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/games` | 创建残局：`{points:[6 个数], borneOff, totalCheckers?, budget?}` |
| GET | `/games/:id` | 查询对局与当前局面 |
| POST | `/games/:id/turns` | 输入骰点 `{die1, die2}`，枚举路径并开回合 |
| GET | `/games/:id/turns/:n` | 查询回合 |
| GET | `/games/:id/turns/:n/paths` | 列出合法完整路径（含每步来源点、骰点、是否离盘、前后数量、未用骰子原因） |
| POST | `/games/:id/turns/:n/explain` | 解释一步 `{from, die}` 的合法性与原因 |
| POST | `/games/:id/turns/:n/submit` | 提交路径 `{path:[{from,die},...]}`，核验通过后一次性落盘 |
| GET | `/games/:id/export` | 导出对局与全部回合 |
| GET | `/games/:id/replay` | 从初态按旧骰点重放已提交路径 |

错误统一返回 `{"error":{"code","message"}}`，HTTP 400。主要错误码：`INVALID_POINTS`、`NON_INTEGER`、`NEGATIVE_COUNT`、`EXCEEDS_TOTAL`、`INVALID_DIE`、`INVALID_POINT`、`EMPTY_POINT`、`BLOCKED_BY_HIGHER`、`DIE_NOT_AVAILABLE`、`EMPTY_PATH`、`NOT_MAXIMAL`（只是合法前缀）、`NOT_MAX_DICE`、`PATH_NOT_OPTIMAL`（违反最大用骰/大骰优先）、`PATH_SET_INCOMPLETE`（枚举预算不足，无法判定）、`STALE_TURN`、`TURN_ALREADY_SUBMITTED`、`GAME_NOT_FOUND`、`TURN_NOT_FOUND`。

## 本题限定规则（规则版本 `sixpoint-v1`）

- 只有本方内盘 1..6 点，棋子不可区分；点位 `p` 用骰 `d`：`p>d` 移到 `p-d`，`p==d` 离盘，`d>p` 仅当比 `p` 更远的点都没有棋子时才允许超点离盘。
- 后一步基于前一步更新后的数量；不同骰点可按任意顺序各用一次；相同骰点（双骰）提供四次同值移动机会。
- 先枚举到无棋子或无可用合法骰子的完整路径，再保留使用骰子次数最多者；不同骰点若只能用一个且较大骰点也有合法路径，必须用大骰。**该筛选对所有候选生效，包括较早离盘完毕的路径**——这是本题明确的受限规则模型。
- 相同棋子身份交换、同值骰子排列不产生新路径（结果已去重）。

与普通双陆棋全局规则的边界：本题**不包含**对手与其棋子、击打与受罚栏（bar）、外盘/完整 24 点棋盘、骰子随机生成、倍增立方体、胜率求解与完整双人对战；也不实现“无法用完骰子时按全局规则另行处理”的其它比赛细则，以上述受限模型为准。

## 持久化与事务

SQLite 保存初态、规则版本、总棋子数、枚举预算、每回合骰点、规范路径集合、选中路径与回合结果。提交路径时先在内存临时状态完成全部核验，通过后在一个事务里更新回合与局面；核验失败不会移动任何棋子。重启进程后重新打开同一数据库即可继续下一回合，也可用 `replay` 按旧骰点重放已提交路径验证一致性。

## 枚举预算

创建对局时可传 `budget`（默认 100000，枚举递归节点上限）。预算不足时回合被标记 `complete=false`：路径列表可能不完整，此时提交路径会收到 `PATH_SET_INCOMPLETE`，服务不会凭截短列表拒绝未出现的路径，也不会宣称已找全；提高预算后重试即可。

## 测试与演示

- `npm test`：13 个用例，覆盖手列小残局的规范路径集合与去重、数量守恒、只剩一颗、全已离盘、空点移动、合法前缀拒绝、大骰优先、非法参数、确定性、预算不足、错误回合不改数据、重启后重放一致、HTTP 全流程。
- `npm run demo`：演示最高点阻止较低点超点离盘、移走最高点后允许离盘、交换两枚骰子顺序产生不同后续、双骰连续使用四次。

## 已知限制

- `node:sqlite` 仍是 Node 的实验模块，未来版本 API 可能调整。
- 单进程服务，无并发提交锁之外的横向扩展设计；同一回合的并发提交由 SQLite 事务与状态检查串行化。
- 枚举预算按递归节点计数，极端局面（15 子全在盘内 + 双骰）若预算不足只会得到未完成标记。
