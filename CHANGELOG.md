# Changelog

## 0.2.19（Linux 适配）

- 新增 Linux x64 / arm64 完整支持：随包原生引擎 `bin/linux-<arch>/cursor-magpie-bridge`、按架构分目录、纳入 `integrity.json` 的 `platforms.linux-x64|arm64` 摘要；`lib/platform.js` 的 `enginePathFor()` 与 `serviceSupported` 同步扩展。Linux 产物以 glibc 2.34（Debian 12 / Ubuntu 22.04）为基线，并以 vendored 方式静态链接 OpenSSL，不依赖目标系统的 `libssl` 版本；arm64 产物在 amd64 容器内交叉编译，无需拉取额外的 Docker 镜像。
- 新增 systemd 用户单元守护：安装器写入 `~/.config/systemd/user/local.magpie.cursor-bridge.service`（`Restart=on-failure`、`UMask=0077`、日志追加到 `supervisor.log` / `supervisor-error.log`），执行 `daemon-reload` 与 `enable --now`；停止、重启、卸载均走 `systemctl --user`，并等待 supervisor/引擎退出。
- 无 systemd 用户实例（容器、部分 WSL、精简发行版）时回退为**分离进程**立即启动，单元文件保留供下次登录接管；systemd 明确拒绝单元时自动 `disable`，避免每次登录重复失败。
- Linux 证书信任全程无需 root：把 CA 路径写入 Cursor 的 `~/.config/Cursor/argv.json`（`certificate-authority`，保留原文件注释），并在存在 `certutil` 时导入用户 NSS 库 `~/.pki/nssdb`；两条路径都会写入 `data/ca/trusted.json` 指纹标记，系统级 CA 仅打印可选命令提示。
- 新增 Linux 专属引擎补丁 `source-linux.patch`：`is_installed()` 在系统 anchor 之外同时接受 Cursor `argv.json` 与 NSS 导入标记，使其与零 root 安装方式一致；macOS / Windows 的引擎判定与二进制不受影响。
- 新增构建入口：`scripts/build-native-linux.sh`（Linux 主机原生构建）与 `scripts/build-native-linux-docker.sh`（在 macOS/Linux 上用 Docker 构建 x64 与 arm64，带 Cargo 缓存卷）；构建前依次应用 `source.patch` 与 `source-linux.patch`，并以 `integrity.json` 的 `engineVersion` 校验 `--version`。
- 控制台在 Linux 启用「启动 / 状态 / 重启」：安装入口统一为 `bash setup.command`，服务状态读取单元文件与 `supervisor.lock`，停止时调用 `systemctl --user stop` 并兜底终止残留进程；页脚、命令提示与 Agent notice 同步更新。
- Linux 每次 setup 后清理旧 release，只保留当前版本；卸载时删除 systemd 单元并 `daemon-reload`。
- 测试新增 Linux 路径、引擎布局、systemd 单元、`argv.json`（保留注释）、NSS 导入与信任标记用例；macOS 专属用例改为按平台跳过。验证结果：macOS 本机 46 项通过；Debian 12 容器内 45 项通过（5 项 Windows 专属跳过）；完成 `setup → argv.json/NSS → 无 systemd 回退 → 卸载` 端到端冒烟；arm64 产物经 QEMU 执行 `--version` 返回 0.2.15。
- 版本号升至 0.2.19；macOS / Windows 引擎构建不变（`engineVersion` 仍为 0.2.15），Linux 引擎由同一上游提交 + Linux 信任补丁构建。

## 0.2.18（易用性：控制台一键连接模型）

- 控制台新增「连接模型」卡片：未连接时直接列出 Magpie 模型目录（读取 `~/.config/magpie/gateway.json` 中的本机网关地址并请求 `/v1/models`，只访问 `127.0.0.1`），选择一个模型点「连接并启动」即可。后台未运行时自动先执行一次 setup，因此首次安装也能一键完成「安装 → 选择模型 → 引擎运行」。
- 连接通过 Magpie 自己的 CLI（`magpie cursor-bridge <model>`）完成，`magpie ls`、Magpie Agents 页面与 `connection.json` 保持一致；连接后控制台最多等待 20 秒，直接显示引擎是否已启动。
- 原生引擎状态区分「等待连接 / 启动中… / 启动失败 / 未运行」：未选择模型时显示「等待连接」而不是令人误解的「未运行」，并在提示中说明这是正常待机状态。
- 新增 `GET /api/agent/models` 与 `POST /api/agent/connect`，均受控制口令与 Host/Origin 校验保护；`createControlServer` 支持注入连接实现以便测试。
- README 补充「未连接 = 待机」说明与一键连接方式；版本号升至 0.2.18，原生引擎不变（仍固定为 0.2.15）。

## 0.2.17（Windows 连接修复）

- 修复 Windows 下「启动」后原生引擎始终未运行：Magpie 的 Agent 沙箱不暴露 `process`，`agent-platform.js` 因拿不到平台信息回退到 macOS 布局，`connection.json` 实际写入 `%USERPROFILE%\.config\magpie-cursor-bridge\`；而 supervisor 只轮询 `%APPDATA%\magpie-cursor-bridge\`，永远处于 `disconnected`，因此不会拉起引擎。现在 `lib/platform.js` 新增 `connectionFilesFor()`，supervisor 与控制台按顺序读取两个候选位置（`%APPDATA%` 优先，`~\.config` 兜底），macOS/Linux 仍只有原路径。
- 控制台概览的 `connection` 与 supervisor 使用同一组候选路径，连接状态不再误报「未连接」。
- 版本号升至 0.2.17；原生引擎未改动，仍由 `integrity.json` 的 `engineVersion` 固定为 0.2.15 并按 SHA-256 校验。

## 0.2.16（Windows 适配修复）

- 修复 Windows「启动」失败（控制台提示「命令退出码 1」）：`schtasks /SC ONLOGON` 需要管理员权限，普通账户只会得到「拒绝访问」。Windows 改为在用户启动文件夹写入隐藏窗口的 `.vbs` 启动器，并立即以分离进程启动 supervisor，安装与登录自启均无需提权；0.2.15 预览版留下的计划任务会在安装/卸载时自动删除。
- 修复证书信任：随包引擎只把 LocalMachine Root 中的证书视为受信任，之前的 `certutil -addstore -user Root` 永远无法通过引擎的 `requires an already trusted CA` 检查（引擎以退出码 1 结束）。现在先读取本机 Root，必要时通过一次 UAC 提权安装并回读验证；之后启动不再询问。取消授权时会给出明确提示。
- Windows 停止后台时同时终止 supervisor 与其派生的原生引擎：TerminateProcess 不会触发 Node/Bun 的退出清理，只杀 supervisor 会把引擎留成孤儿；终止前校验命令行，避免进程号被无关程序复用时误杀。
- Windows 下探测进程命令行、运行安装器与数据库 CLI 时统一隐藏窗口（`windowsHide`），避免状态轮询与「启动」操作闪出控制台窗口；该参数在 macOS/Linux 上无效果。
- `magpieConfigDirFor()` 在 Windows 改用 Magpie 实际使用的 `%USERPROFILE%\.config\magpie`（`magpie data` 报告的位置）。之前指向 `%APPDATA%\magpie`，安装器读不到 `plugins.json`，会重复登记插件，导致两个控制服务争用 3580 端口并反复输出 `EADDRINUSE`。检测到重复登记时会提示但不擅自删除。
- Windows 每次 setup 后清理旧 release（每份约 100–190 MB），只保留当前版本。
- 控制台在 Windows 改为读取启动文件夹与 `supervisor.lock` 判断后台状态，不再查询计划任务；「重启」提示与页脚同步更新。
- 数据库面板在缺少 `sqlite3` 可执行文件时自动改用 Magpie 内置 Bun 的 `bun:sqlite`（Windows 默认没有 sqlite3）；macOS 仍优先使用系统 sqlite3，行为不变。
- 测试适配 Windows：路径断言进入临时沙箱、跳过 Unix 文件权限断言、证书与激活用例按平台分支，数据库用例在无 sqlite3 时跳过。
- 版本号升至 0.2.16。原生桥接源码未改动，沿用已发布的 0.2.15 引擎构建；`integrity.json` 新增 `engineVersion` 单独固定随包引擎版本，插件版本与引擎版本分别校验（旧包缺少该字段时仍要求两者完全一致，macOS 行为不变）。

## 0.2.15（本地增强版）

- 新增 Windows x64 原生引擎：`bin/win32-x64/cursor-magpie-bridge.exe`，交叉编译产物为自包含 PE（仅依赖 Windows 系统 DLL），并纳入 `integrity.json` 的分平台摘要。
- `bridge.js` 按平台选择引擎（Windows 为 exe），Windows 下跳过 Unix `umask`。
- 安装器支持 Windows：证书信任改用 `certutil -addstore -user Root`，后台通过计划任务 `local.magpie.cursor-bridge`（登录自启 + 立即运行）守护，卸载时删除任务；`stage` 只携带当前平台的引擎与运行时。
- 控制台在 Windows 上启用「启动 / 重启」：通过宿主运行时执行 `install.js`，停止时结束计划任务并终止 supervisor/engine；状态查询走 `schtasks` + `supervisor.lock`。
- 修复 `source.patch` 中 `tokio::signal::unix` 缺少 `#[cfg(unix)]` 保护导致 Windows 编译失败的问题，改用跨平台的 termination future。
- 新增 `scripts/build-native-windows.sh`，在 macOS 上用 mingw-w64 交叉编译 Windows 产物并更新分平台摘要。
- 版本号升至 0.2.15，macOS 与 Windows 原生桥接按新版本号重建。

## 0.2.14（本地增强版）

- 修复 0.2.12 引入的插件加载回归：Magpie 的 agent 沙箱只解析 `agent.js` 同目录模块并拒绝 `node:` 内置模块，之前 `agent.js` 直接导入 `node:os` / `node:path` / `lib/platform.js`，导致插件清单加载失败、侧栏与 Agent 行异常。
- 平台路径计算移入无导入的 `agent-platform.js`（仅使用 `globalThis.process`，缺失时回退 macOS 默认值），`agent.js` 改为导入同目录模块。
- 修复 0.2.12 引入的稳定副本缺依赖问题：`setup.command` 注册的 `~/.local/share/magpie-cursor-bridge` 只复制了 `control`/`ui`，而 `control/host.js` 已依赖 `../lib/platform.js`；现在同时复制 `lib`、`vendor` 与 `agent-platform.js`。
- `lib/install.js` 的 payload 与 `package.json` 的 `files` 加入 `agent-platform.js`，确保发布包与 release 目录包含该文件。
- 版本号升至 0.2.14，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

## 0.2.13（本地增强版）

- 数据库统计从三次全表扫描降为一次：`messages` 的行数、按天增长与会话分布共用一次 `GROUP BY`；实测 2.6GB 库从 3.0 秒降至 2.3 秒。
- 内容块（`blobs` / `blob_edges`）的体积改为按需统计：默认快速统计跳过逐行读取 blob 正文，控制台新增「精确统计」按钮补齐；实测精确统计 3.4 秒。
- 修复 `engine.log` 运行期不轮转的问题：改为按累计写入量轮转，不再依赖 supervisor 重启；超过上限时滚动到 `engine.log.1`。
- Cursor `settings.json` 按 mtime/size/inode 缓存解析结果，supervisor 每 2 秒的代理检查不再重复解析同一份 10–50KB JSONC。
- Magpie `plugins.json` 同样按文件标识缓存，2 秒端口轮询不再重复解析。
- 控制台状态接口增加 2 秒快照缓存，多面板并发轮询只执行一组 `ps`/`launchctl`。
- `/api/settings` 写操作串行化，避免两个面板同时保存时互相覆盖。
- 前端轮询在页面隐藏时退避到 30 秒。
- 原生 SQLite：WAL 下 `synchronous` 调整为 `NORMAL`（崩溃最多丢失最近事务，不损坏数据库），每连接缓存 8MB、mmap 64MB，改善多会话并发写入与读延迟。
- 版本号升至 0.2.13，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

## 0.2.12（本地增强版）

- 新增 `lib/platform.js` 跨平台抽象层：配置/数据目录、Cursor 配置与安装目录、Magpie 配置目录、进程命令行探测、打开路径、`sqlite3` 与 `bash` 探测全部按平台解析；macOS 的路径与行为保持不变。
- Windows：配置与数据目录改用 `%APPDATA%` / `%LOCALAPPDATA%`，存在旧 `~/.config` 数据时自动沿用；进程探测改用 PowerShell；打开路径改用 `explorer`；`renameSync` 在目标文件被占用时短暂重试。
- Linux：配置与数据目录遵循 XDG，打开路径改用 `xdg-open`。
- 非 macOS 平台：安装器、证书信任与服务守护明确提示「仅 macOS」；控制台禁用「启动/重启」并显示原因，「状态」仍可读取 `status.json`。
- `package.json` 移除 `os: darwin` 与 `cpu: arm64` 的硬限制（原生引擎仍需对应平台构建产物）；`agent.js` 的 Cursor 目录与连接文件路径改为按平台计算。
- 新增 `test/platform.test.js` 覆盖 macOS / Linux / Windows 三套路径布局。
- 版本号升至 0.2.12，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

## 0.2.11（本地增强版）

- 修复控制台在插件重载、端口切换或升级后提示「控制口令无效」的问题：收到 403 且错误为「控制口令无效」时自动重新加载页面以获取当前令牌；15 秒冷却避免异常环境下的重载循环，冷却期内改为明确提示手动刷新，不再误报「控制服务不可达」。
- 控制台头部新增「刷新页面」按钮（重新加载页面并获取当前口令）；原「刷新」按钮更名为「刷新状态」（仅重新读取运行状态，不更新口令），避免两者语义混淆。
- 版本号升至 0.2.11，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

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
