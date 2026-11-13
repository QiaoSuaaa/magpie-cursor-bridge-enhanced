# Changelog

## 0.2.10（本地增强版）

- 控制台新增「数据库管理」卡片：按会话与消息、检查点、运行与工具调用、请求调用日志、内容存储（blob）、配置与系统六类展示 `bridge.db` 的表行数与内容体积，并给出数据库文件、WAL、索引与空闲页、页大小及最近写入时间。
- 新增最近会话与近 7 天消息增长视图，便于判断历史数据分布。
- 新增分级清理：调用日志（`llm_calls` / `cursor_run_traces`）、按天清理历史会话（blob 内容保留）、仅 VACUUM 压缩、清空全部运行数据（保留模型配置与服务设置）。清理前暂停桥接，完成后自动重启；全量清空需输入「清空全部」二次确认。
- 统计与清理通过系统自带 `/usr/bin/sqlite3` 执行，只读统计不持有长期连接；内容体积按 UTF-8 字节计算，避免中文文本被低估。
- 快捷入口新增「数据目录」。
- 版本号升至 0.2.10，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

## 0.2.9（本地增强版）

- 修复通过 Magpie 插件页从 GitHub 安装后启动报 `Cannot find package 'jsonc-parser'` 的问题：`jsonc-parser` 以 ESM 运行时形式 vendored 到 `vendor/jsonc-parser`，不再依赖 `npm install`。
- staging 与安装校验改为读取 vendored 目录；移除 `package.json` 的 npm 依赖与 `npm-shrinkwrap.json`。
- 版本号升至 0.2.9，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.8（本地增强版）

- 控制台新增「子代理模式」：
  - `异步后台`（默认）：保持现状，子代理在后台运行，完成后由桥接唤醒父代理继续。
  - `同步阻塞`：原生层强制 Task 以 `run_in_background=false` 下发，客户端内联执行子代理，父代理等待其结果；同时 `is_background` 恒为 false，不进入后台唤醒逻辑。
  - 切换后 supervisor 在数秒内重启引擎，下一次 Task 调用生效。
- 原生层新增 `CURSOR_BRIDGE_SUBAGENT_MODE`（`async` / `sync`），仅在 `sync` 时改写 `SubagentArgs.run_in_background`。
- 版本号升至 0.2.8，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.7（本地增强版）

- 修复 Multitask 后台子代理完成后父代理不继续的问题：
  - 本地 Statsig bootstrap 显式启用 `long_running_jobs`。Cursor 未登录时上游 bootstrap 返回 401，客户端只有在 gate 开启时才会派发后台任务完成通知；缺失它时子代理即使跑完也不会唤醒父代理，这是本次的主因。
  - `is_background` 保留两条异步信号：模型显式 `run_in_background` 与客户端回报的 `SubagentBackgroundReason`，任一为真即按后台处理；只有两者都没有时才视为同步。异步模式语义不变。
  - 活跃流上收到 `BackgroundTaskCompletionAction` 不再被当作 unsupported action 丢弃：父 run 仍在输出时注入通知并打断当前 round；已结束时用完成通知重放父请求，开启新一轮模型调用。
  - 收到完成通知时把 `subagent_runs_by_parent_tool_call_id` 的状态从 `Backgrounded` 更新为 `Success / Error / Aborted` 并写入完成时间；界面不再停在 “Stopped”。
- 原生桥接启动时初始化 tracing，诊断日志走 stderr 进入 `engine.log`（默认 `cursor_server=info`，可用 `RUST_LOG` 覆盖）；stdout 仍只承载 supervisor 解析的 ready 事件。
- 同步阻塞模式（`run_in_background=false` 或客户端同步完成）路径不变。
- 版本号升至 0.2.7，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.6（本地增强版）

- 控制台新增「运行模式」：默认模式（现状）与轻量模式。轻量模式把整个 SQLite 放入引擎进程内存（sqlx shared-cache 内存库）：请求转发、会话、工具调用照常工作，但不再写入 `data/bridge.db`；引擎重启后会话历史清空。
- supervisor 每轮读取 `bridge-settings.json`；运行模式变化后自动重启原生引擎，当前对话可能中断一次。
- 接入此前声明但未生效的三个参数：模型目录同步间隔、网关断线容错、引擎日志上限现在由 `bridge.js` 实际读取（前两者下一轮生效，日志上限下次后台启动生效）。
- 控制台概览新增「运行模式」「数据库」：轻量模式显示「内存 · 不落盘」；`status.json` 增加 `mode` / `engineMode`，可区分已保存与已应用。
- 原生桥接读取 `CURSOR_BRIDGE_RUN_MODE=lite` 时改用 `Store::connect_lite()`；内存库保持共享缓存与常驻连接，避免空闲回收后丢失表结构。
- 版本号升至 0.2.6，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.5（本地增强版）

- Magpie Agent 行菜单新增「桥接控制台」入口（侧栏插件组同名页面）：打开本机控制台执行启动（`bash setup.command`）、状态（`bash setup.command status`）与重启（`launchctl bootout` + 终止进程 + `setup.command`），并展示运行概览、日志与目录快捷入口。代理卡片内部由 Magpie 内置 UI 渲染，插件无法直接插入控件。
- 新增可编辑参数 `~/.config/magpie-cursor-bridge/bridge-settings.json`：模型目录同步间隔（默认 15 秒）、网关断线容错（默认 60 秒）、引擎日志上限（默认 4 MiB）；控制台保存后下一轮生效（日志上限下次后台启动生效）。
- 控制服务由 Magpie 插件宿主拉起，仅监听 `127.0.0.1`（默认 3580），带每次启动随机口令并校验 `Host`/`Origin`；后台桥接停止时仍可启动。
- 修复控制台在 Magpie 沙箱页中 CSS/JS 被 CSP `'self'` 拦截的问题（沙箱为 opaque origin）：改为显式 `http://127.0.0.1:<port>` / `http://localhost:<port>` 源，样式与按钮恢复。
- Agent 行与侧栏插件页改用 Cursor 官方图标（`ui/cursor.svg`，`agent.icon` 内联 data URI）。
- 修复 `setup.command` 在插件按本地路径注册时误判未注册、重复注册本地描述符的问题。
- 版本号升至 0.2.5，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.4（本地增强版）

- 模型选择器显示名只保留第一段（如 `Opus`、`Sonnet`、`Fable`、`Qwen4-Max-Preview`），不再拼接 ` · routing group` 与模型 ID，避免三段长名挤占 Cursor 的模型列表。
- 短名规则：取 Magpie 模型名中第一个 `·` 之前的部分；名称为空时回退到模型 ID。

## 0.2.3（本地增强版）

- 修复 Cursor 3.29+ 无法发起对话：客户端新增 `bidi_append_binary_encoding_disabled` 开关（默认关闭），首个 `BidiAppend` 改用 `data_binary`（tag 4，原始 protobuf 字节）而不是 `data`（hex 字符串）。旧桥接直接拒绝 `data_binary`，返回 `InvalidArgument`，客户端标记为不可重试并空等 30 秒，最终提示 "Connection stalled"。现在 `decode` 同时接受两种编码。
- 解码失败时将原始二进制写入 `$TMPDIR/bidi-dump-<seqno>.bin`（原为 `.hex` 文本），便于继续对齐协议。
- 版本号升至 0.2.3，避免与上游 0.2.2 的 release 目录和校验摘要混淆。

## 0.2.2

- 修复 Cursor 3.27 起 Composer 完全不可用：Cursor 服务端会灰度下发 `agent_host_local_loop`（本地循环运行时），此后 `BidiAppend` 里装的是新的 `RunInferenceRunRequest` 报文，与桥接的 `AgentRunRequest` 不兼容，表现为 `protobuf decode error` → HTTP 502 → Composer 提示 "The server failed 4 times"。现在在 Statsig bootstrap 中显式关闭该开关，回退到桥接支持的经典 agent 循环。
- 兼容 `ConversationStateStructure.plan` 的 wire type 变化：该字段改为未知字段跳过，不再中断整包解析。
- 本机监听端口持久化到 `network_ports`：桥接重启不再换端口，Cursor 不需要跟着重启。
- Magpie 网关短暂不可用时不再立即断开（保留 60 秒宽限，状态里给出 `warning`），连续超时才回退到 Cursor 官方服务。
- 模型目录未变化时不再每 15 秒重写 `effective.json`。
- 原生桥接的诊断输出写入 `~/.config/magpie-cursor-bridge/engine.log`（0600，超过 4 MiB 轮转），便于排查协议变更。
- 监视器 lock 增加命令行校验，避免进程号复用导致启动被误判为"已有实例"。
- 服务 plist 增加 `LimitLoadToSessionType=Aqua`。
- 协议解码失败时把原始报文写到 `$TMPDIR/bidi-dump-<seqno>.hex`，供后续协议对齐。

## 0.2.1

- Hide Cursor Auto in the bridge model picker using Cursor's display configuration, including clearing cached Auto controls. Magpie models and route groups remain selectable.

## 0.2.0

- Standard Magpie Agent package with an explicit file allowlist and bundled JavaScript dependency.
- Independent, per-machine certificate initialization; no original Cursor BYOK installation needed.
- Explicit macOS certificate trust step with SSL trust verification; existing certificates preserved.
- Setup reuses Magpie's Bun and keeps a local runtime copy, removing the dependency on user-installed Node.
- Plugin/native version pairing and native SHA-256 verification.
- Complete version directories and rollback of launch configuration after failed service registration.
- Status reports the actual running version. Updating the plugin requires rerunning setup to activate the matching service.
- Apple Silicon macOS only; no installation lifecycle scripts and no credentials in the package.

## 0.1.1

- Return only Magpie's model catalogue, without appending Cursor subscription models.

## 0.1.0

- Cursor protocol bridge through Magpie, background lifecycle, and recoverable proxy settings.
