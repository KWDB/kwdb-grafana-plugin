# 真实 KWDB 实例验证工具

这两个脚本用**插件自己的源码**生成 SQL，再逐条在真实 KWDB 上执行，用来验证"编辑器里点出来的语句数据库到底认不认"。

它们不是插件的一部分：不参与 `yarn build` / `mage buildAll`，不发版，只在需要真机验证时手动跑。

## 用法

先设置连接信息（**没有默认值**，缺任何一个都会直接报错退出），然后先生成、再执行：

```bash
export KWDB_HOST=db.example.com
export KWDB_PORT=26257
export KWDB_DATABASE=example_db
export KWDB_USER=readonly_user
export KWDB_PASSWORD='<password>'

# 1. 生成 SQL（用 src/sqlBuilder.ts 和 src/variableQuery.ts 的真实实现）
npx ts-node --compiler-options '{"module":"commonjs","moduleResolution":"node","target":"es2020","esModuleInterop":true,"strict":false}' verify-real/gen.ts

# 2. 逐条执行并记录结果
npx ts-node --compiler-options '{"module":"commonjs","moduleResolution":"node","target":"es2020","esModuleInterop":true,"strict":false,"types":["node"]}' verify-real/run.ts
```

`gen.ts` 里的库名/表名使用的是示例名（`example_db` / `equipment_telemetry`），换环境时改文件顶部的常量或在 SQL 用例里替换即可。

## 文件

| 文件                          | 作用                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gen.ts`                      | 生成 `cases.json`：56 条 SQL + 模板变量往返用例。只展开 `$__timeFrom`/`$__timeTo`（与 `pkg/plugin/macros.go` 一致）；若生成的 SQL 里仍含 `$__timeFilter`/`$__timeGroup` 会直接抛错，因为这两个宏由后端展开，不能原样执行 |
| `run.ts`                      | 读 `cases.json`，逐条 psql 执行，写 `results.json`。`expectFail: true` 的用例失败时记为 `xfail`（按设计被数据库拒绝），不计入失败数                                                                                      |
| `cases.json` / `results.json` | **生成物，已被 `.gitignore` 忽略，不要提交**；`results.json` 只是某次真机运行的证据                                                                                                                                      |

## 状态含义

- `ok` — 执行成功
- `FAIL` — 执行失败，需要看错误
- `xfail` — 按设计被 KWDB 拒绝（本轮重跑没有此类用例；legacy gapfill `none` 已被纠正为 `avg`）
- `----` — 构建器按设计返回空串（危险片段、非正整数 COUNT_WINDOW 参数）

## 记录结果

2026-10-29 对一台真实 KWDB 实例重跑：56 条中 52 条通过、0 失败、4 条按设计返回空串、0 条按设计失败。legacy gapfill 的 `none` 已在 SQL 层纠正为 `avg`，`WN-gapfill-agg-none` 通过。
完整报告（地址与账号已脱敏）为内部文档，不随仓库发布。

## TLS 验证用的证书

`verify-real/tls/` 存放指向 TLS 实例所需的证书，**已被 .gitignore 忽略，不要提交**——里面含私钥，即使是一次性测试密钥也不该进仓库。证书需要**自备**，本仓库不提供。

需要的文件：

| 文件                                  | 用途                                               |
| ------------------------------------- | -------------------------------------------------- |
| `ca.crt`                              | `KWDB_TLS_ROOT_CERT`，`verify-ca`/`verify-full` 用 |
| `client.root.crt` / `client.root.key` | 可选的客户端证书认证                               |

另需一个**没有**签发该节点证书的 CA 作为 `KWDB_TLS_FOREIGN_CA`，用来证明客户端真的在校验证书链。

生成方式（在 KWDB 服务器上，`kwbase` 即 `kwbase cert` 一族命令）：

```bash
kwbase cert create-ca     --certs-dir=<dir> --ca-key=<dir>/ca.key
kwbase cert create-node   --certs-dir=<dir> --host=<ip>,localhost
kwbase cert create-client root --certs-dir=<dir> --ca-key=<dir>/ca.key
```

注意 `create-node` 的 `--host` 要带 **DNS 名**：libpq 的 `verify-full` 连 IP 主机时，OpenSSL 的 `X509_check_host()` 不匹配 IP SAN，只给 IP 会报 `certificate for "localhost" does not match host name`。Go/pgx 原生支持 IP SAN，不受影响。

完整结论见内部真机验证报告第六节（不随仓库发布）。
