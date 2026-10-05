# 双陆棋六点残局用骰与离盘路径后端

仅后端（HTTP API + CLI），使用 **TypeScript + Node.js + 内置 SQLite（`node:sqlite`）**。
在 Windows 本地运行，不依赖 Docker、WSL、付费服务或任何外部在线 API。
运行时依赖为 **0**（SQLite 由 Node 内置），仅构建期依赖 `typescript` 与 `@types/node`。

要求 Node.js `>= 23.6`（开发与验证使用 Node v25；用到内置 `node:sqlite` 与类型剥离）。

## 本题限定规则（与普通双陆棋全局规则的边界）

本服务**只**研究单方离盘（bearing-off）阶段，刻意不包含普通双陆棋的下列内容：

- 不含对手棋子、击打（hit）、被击回到受罚栏（bar）、再入场；
- 不含骰子随机生成（骰点由调用方直接给定）；
- 不含倍增立方体（doubling cube）、赌注、胜率/期望求解或完整双人对局；
- 只保留本方内盘距离离盘 1～6 步的六个点，外加“已离盘数量”。

点位约定：数组 `points` 长度为 6，`points[i]` 表示距离离盘 `i+1` 步的点上棋子数，
即索引 0 是一点（最近，p=1），索引 5 是六点（最远，p=6）。棋子彼此不可区分。

### 单步移动规则

对点 p 的棋子使用骰点 d：

- `p > d`：移到更近的点 `p-d`，不离盘；
- `p = d`：精确离盘；
- `d > p`（超点离盘）：**仅当所有比 p 更远的点（p+1..6）都没有棋子时**才允许离盘，
  否则被更远的棋子阻止。

每一步都基于“上一步更新后的数量”判定，绝不复用回合开始时的最高点。

### 骰子与路径

- 两个不同骰点：各使用一次，但可按任意顺序使用；
- 相同骰点（双骰）：提供四次同值移动机会；
- 搜索不断推进，直到无棋子或无任何合法骰子为止；
- 在所有完整路径中**只保留使用骰子次数最多者**；
- **受限大骰优先（本题明确的受限模型）**：两个不同骰点、且较大骰点在初始盘面存在合法走法时，
  一律只保留首步使用较大骰点的路径。该筛选作用于**所有候选，包括已经提前离盘完毕的路径**，
  不引入普通比赛规则来跳过此筛选；
- 相同棋子的身份交换不产生新路径；相同骰点也不制造重复结果。

未使用的骰点会给出原因：`no_checkers`（已无棋子）或 `no_legal_move`（有子但无合法走法）。

### 枚举预算

创建残局时可设 `budget`（状态节点展开数上限，默认 100000）。预算耗尽时结果
`complete=false`：此时**只表示没找全**，不会凭截短列表拒绝任何未出现的路径，也不会宣称已找全。
提交核验使用独立的高预算枚举；若连核验枚举都不完整，返回 `ENUMERATION_INCOMPLETE`，不下结论。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # node --test，18 个用例（引擎 + 持久化/重放）
npm run demo      # 纯引擎四组关键场景演示
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
```

指定端口与数据库：

```powershell
node --experimental-strip-types src/cli.ts serve --port 3000 --db data/bg6.db
```

SQLite 数据文件默认放在项目内 `data/bg6.db`（自动创建目录）。
也可运行编译产物：`node dist/cli.js serve`。

## CLI

```powershell
# points 按“一点..六点”顺序给六个非负整数；--total 为总棋子数（默认15）
node --experimental-strip-types src/cli.ts create --points 0,1,0,0,0,1 --total 2
node --experimental-strip-types src/cli.ts dice   --game <id> --dice 3,5
node --experimental-strip-types src/cli.ts paths  --turn 1
node --experimental-strip-types src/cli.ts explain --turn 1 --p 6 --d 5
node --experimental-strip-types src/cli.ts submit --turn 1 --path '[{"p":6,"d":5},{"p":2,"d":3}]'
node --experimental-strip-types src/cli.ts turn   --turn 1
node --experimental-strip-types src/cli.ts replay --turn 1
node --experimental-strip-types src/cli.ts export --game <id>
```

CLI 用六点数量表展示中间状态，不含任何棋盘网页。

## HTTP API

所有响应为 `{ ok, data }` 或 `{ ok:false, errorCode, message }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/games` | 创建残局：`{points:[6个], borneOff?, totalCheckers?, budget?}` |
| GET | `/api/games/:id` | 查询残局与当前盘面/回合 |
| POST | `/api/games/:id/dice` | 给定骰点开启回合：`{d1,d2}` |
| GET | `/api/turns/:id` | 查询回合 |
| GET | `/api/turns/:id/paths` | 列出合法完整路径（含每步前后数量、未用骰原因、预算完成标记） |
| GET | `/api/turns/:id/explain/:p/:d` | 解释从回合初态执行一步的局部合法性与前后数量 |
| POST | `/api/turns/:id/submit` | 提交路径：`{steps:[{p,d}], turn?}`，`turn` 为乐观回合号 |
| POST | `/api/turns/:id/replay` | 按已存骰点重放已提交路径并重新核验 |
| GET | `/api/games/:id/export` | 导出规则版本、残局、全部回合与选中路径 |

路径每步返回来源点 `p`、骰点 `d`、是否离盘 `borneOff`、目的点 `toP`，
以及 `before/after` 六点数量与 `borneOffBefore/borneOffAfter`。

## 错误码

| errorCode | 含义 |
| --- | --- |
| `INVALID_POINTS` | 六点数量不是长度 6 的非负整数数组 |
| `INVALID_BORNE_OFF` | 已离盘数量非法（负数/非整数） |
| `INVALID_TOTAL` / `INVALID_BUDGET` | 总棋子数 / 枚举预算非法 |
| `TOTAL_EXCEEDED` | 盘内 + 离盘 超过总棋子数 |
| `CONSERVATION_VIOLATION` | 盘内 + 离盘 不守恒 |
| `INVALID_DICE` | 骰点不是 1..6 整数 |
| `GAME_NOT_FOUND` / `TURN_NOT_FOUND` | 残局 / 回合不存在 |
| `TURN_OPEN` | 已有未提交回合，不能再开新回合 |
| `TURN_ALREADY_SUBMITTED` | 回合已提交，不能重复提交 |
| `TURN_EXPIRED` | 提交到非最新回合，或乐观回合号不一致（HTTP 409） |
| `INVALID_MOVE_SHAPE` | 提交步缺少合法 `p/d` 或越界 |
| `ILLEGAL_MOVE` | 该步局部不合法（空点、被更远点阻止超点等） |
| `DIE_NOT_AVAILABLE` | 该骰点已用尽或不属于本回合 |
| `NOT_MAXIMAL` | 只提交了合法前缀，未达到本回合最大用骰数 |
| `NOT_LARGE_DIE_FIRST` | 不满足受限大骰优先或非规范完整路径 |
| `ENUMERATION_INCOMPLETE` | 核验枚举因预算不足未完成，无法判定 |
| `INVALID_JSON` / `NOT_FOUND` / `INTERNAL` | 请求体非法 / 路由未知 / 服务器内部错误 |

## 持久化与事务

SQLite 保存初态、固定规则版本（`bg6-bearoff-v1`）、每回合骰点、选中路径与回合结果。
提交时先在临时状态做整条路径核验（局部合法 + 骰槽 + 最大用骰 + 大骰优先 + 守恒），
通过后才在单个 `BEGIN IMMEDIATE` 事务内一次性落盘；任一步失败即 `ROLLBACK`，
**不会只移动前几颗棋子**。重启后可继续下一回合，也可按旧骰点 `replay` 已提交路径。

## 关键场景（见 `npm run demo`）

1. p2 与 p6 各一子，骰 [3,5]：p2 想用 3 超点离盘被更远的 p6 阻止；
2. 同一局面先用大骰 5 把 p6 移到 p1 后，p2 才允许用 3 离盘（大骰优先给出唯一规范路径）；
3. p4、p5 各一子，骰 [2,3]：首步大骰 3 有多个来源点，产生不同后续；
4. p1 四颗，骰 [1,1]：双幺连续使用四次，四枚全部离盘。

## 目录

```
src/engine/ 规则 rules.ts、枚举 enumerate.ts、整条核验 validate.ts、类型 types.ts
src/db/     SQLite 存储与事务 store.ts
src/        service.ts（业务编排）、server.ts（HTTP）、cli.ts（CLI/演示）
tests/      引擎与持久化用例（含手算小残局、边界、守恒、重放、确定性）
data/       SQLite 数据目录（运行时生成）
```

## 已知限制

- 仅限单方六点离盘残局；不推断全局双陆棋行为。
- “大骰优先”按本题要求作为对所有候选（含提前清空路径）的强制受限规则，
  与某些真实赛制“能离盘即可”的裁量不同，属刻意建模。
- `node:sqlite` 在当前 Node 版本会打印一条 ExperimentalWarning，不影响功能。
