# cursor-agent 接管调研与验证报告

> 调研日期：2026-11-20
> 环境：cursor-agent `2026.11.19-f005e9d`（macOS arm64）、cursor-bridge `0.2.32`、Magpie 网关 `127.0.0.1:3425`
> 结论：**可行，且已完成端到端实证**。cursor-agent 可与 Cursor IDE 共用同一套桥接引擎，无需修改引擎代码。

---

## 一、结论摘要

按承重层级，把结论拆成三层，避免把“链路通”误当成“产品完成”：

| 层级 | 结论 | 证据 |
|---|---|---|
| 接管通道 | ✅ 已验证 | 桥接代理对 `api2.cursor.sh` 与 `agentn.global.api5.cursor.sh` 均签发 `Cursor BYOK Local CA`；CLI 自带 Node 在 `--use-system-ca` 下验证通过 |
| 协议与模型目录 | ✅ 已验证 | CLI 内嵌 `aiserver.v1.BidiService/BidiAppend`、`agent.v1.AgentService/RunSSE`，与 IDE 同 proto；`--list-models` 通过代理直接列出 Magpie 的 5 个模型 |
| 对话端到端 | ✅ 已验证 | `-p` 模式实际对话返回「收到」，引擎日志完整记录 `user_message → routing to BYOK → Run Completed` |
| 工具调用回环 | ✅ 已验证 | CLI 写入 `probe.txt` 并执行 `cat`，引擎记录两轮 `tool round`，`tool result committed ... settled=true` |
| 产品化封装 | ✅ 0.2.33 | `lib/cursor-agent.js` + setup 自动安装包装器 + 控制台「cursor-agent 接管」卡片 + 独立版本门禁 |
| persist / 子代理 / 跨平台 | ⬜ 待补测 | `persist` 仅验证了 `list` 透传；独立会话进程、后台子代理、Windows / Linux 的 CA 信任路径未实机验证 |

---

## 二、实证记录

### 2.1 接管通道：MITM 覆盖与 CA 信任

```bash
# 经桥接代理（端口取自 status.json 的 proxy 字段）访问两个 Cursor 域
curl -v --proxy http://127.0.0.1:58160 --cacert ~/.config/magpie-cursor-bridge/data/ca/ca.crt \
  https://agentn.global.api5.cursor.sh/
# issuer: CN=Cursor BYOK Local CA; O=Cursor BYOK  → MITM 生效且证书校验通过

# 非 Cursor 域（example.com）：
# issuer: Cloudflare TLS Issuing ECC CA 3 → 直通隧道，不做 MITM
```

CLI 启动器默认追加 `--use-system-ca`，而系统钥匙串已把 `Cursor BYOK Local CA` 标记为 `kSecTrustSettingsResultTrustRoot`。用 CLI 自带 Node 对 api2 / api5 做 TLS 探测，两个域名均握手成功。

### 2.2 协议同构

在 CLI 的 `index.js` 中提取到的服务定义：

- `aiserver.v1.BidiService/BidiAppend`（Unary）——与 IDE 上行完全一致
- `agent.v1.AgentService/{Run, RunSSE, RunPoll, ...}`——CLI 内部把 `Run` 映射为 `RunSSE`（ServerStreaming），即 IDE 的调用形态
- 模型目录 RPC：`aiserver.v1.AiService/{AvailableModels, GetUsableModels, GetDefaultModelForCli}`——正是桥接已实现合并逻辑的接口

### 2.3 CLI 的代理支持

CLI 的 HTTP/2 连接池（`src/bridge/proxy-http2-session-manager.ts`）按目标协议读取 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY`，并以 `proxyUrl` 建立会话；认证与普通 HTTPS 请求另有 `ProxyAgent` 装配。worker 子进程的环境变量白名单已确认包含 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`NODE_EXTRA_CA_CERTS`。

### 2.4 端到端

```bash
HTTPS_PROXY=http://127.0.0.1:58160 cursor-agent --list-models
# 输出 Magpie 的 5 个模型（hash 标识，显示名 Opus / Sonnet / Fable / GPT-6.2 Sol / GPT-6.2 Astra）

HTTPS_PROXY=http://127.0.0.1:58160 cursor-agent -p --trust --model <hash> '只回复两个字：收到'
# CLI 输出：收到
# engine.log:
#   bidi append received ... action="user_message"
#   routing Cursor Run to BYOK provider model_id="<hash>"
#   Run claimed conversation ownership checkpoint_id=...
#   Run ended outcome=Completed usage=Some(Usage { ... })
```

日志同时出现 `appending BYOK models to Cursor AvailableModels` 与 `... GetUsableModels`，说明模型目录由本地引擎注入，而非官方返回。

工具回环验证：

```bash
cursor-agent -p --trust --force --model <hash> \
  '在当前工作目录创建 probe.txt，内容为 hello，然后用 shell 执行 cat probe.txt'
# 文件创建成功，cat 输出 hello
# engine.log:
#   tool round started round_id=... round:0 calls=1
#   tool result committed ... settled=true
#   tool round started round_id=... round:1 calls=1
#   tool result committed ... settled=true
#   Run ended outcome=Completed
```

---

## 三、架构定位

cursor-agent 不是第二个引擎，而是同一引擎的**第二个接入面**：

```text
                    ┌────────────────────────────────────────┐
                    │ Magpie 网关 127.0.0.1:3425/v1           │
                    └──────────────────▲─────────────────────┘
                                       │ OpenAI 兼容
                    ┌──────────────────┴─────────────────────┐
                    │ 原生桥接引擎（Rust + hudsucker）         │
                    │  127.0.0.1:58160  MITM + Connect/protobuf│
                    └───────▲──────────────────────▲──────────┘
                            │ http.proxy            │ HTTPS_PROXY
                ┌───────────┴─────────┐   ┌────────┴─────────────┐
                │ Cursor IDE（settings）│   │ cursor-agent（env）   │
                └─────────────────────┘   └──────────────────────┘
```

两个接入面的差异只在“如何把流量导进代理”：

- IDE：supervisor 写 `settings.json` 的 `http.proxy`，并维护 `settings-journal.json` 以便还原；
- CLI：不读 IDE 设置，只能靠环境变量注入。这条通道与 IDE 的 journal 体系正交，不应混入同一套还原逻辑。

---

## 四、接入方案

### 方案 A：环境变量包装器（已落地，0.2.33）

提供一个 `bin/cursor-agent-bridge`（或在 setup 时生成 shell 函数）：

```sh
#!/bin/sh
# 运行时读取 supervisor 导出的纯文本环境文件，避免解析 JSON
ENV_FILE="$HOME/.config/magpie-cursor-bridge/agent-env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
exec cursor-agent "$@"
```

由 supervisor 在 `status.json` 更新时同步写出 `agent-env`：

```sh
export HTTPS_PROXY=http://127.0.0.1:58160
export NODE_EXTRA_CA_CERTS=/Users/<user>/.config/magpie-cursor-bridge/data/ca/ca.crt
```

要点：

- `HTTPS_PROXY` 已在实机验证；`NODE_EXTRA_CA_CERTS` 作为 `--use-system-ca` 之外的双保险，覆盖 `AGENT_CLI_CREDENTIAL_STORE=file` 跳过系统 CA 的场景；
- 不设置 `NO_PROXY`（或只在用户显式配置时透传），避免 CLI 绕过接管；
- 端口由 supervisor 写出，兼容轻量模式重启后的端口复用逻辑；
- worker / persist 子进程会继承上述环境变量（`persist` 待实测确认）；
- 不使用 `sed` 解析 `status.json`：项目本身是 Node，若必须读 JSON 也应走 `node -e` 或已有工具函数；首选 supervisor 直出环境文件。

### 方案 B：CLI 端点覆盖（不推荐作为主路径）

CLI 暴露了 `-e/--endpoint`（默认 `https://api2.cursor.sh`，env `CURSOR_API_ENDPOINT`）与内部的 `agentEndpoint` 覆盖。但桥接是 TLS 代理而不是明文 HTTP 服务，把端点指向本地会绕过 MITM 与协议转译；本地后端端口还是随机的。仅可作为调试手段。

### 方案 C：shell 集成

CLI 自带 `install-shell-integration`（写入 `~/.zshrc`）。可考虑在同一入口追加导出语句，但会与官方安装器的升级/卸载行为耦合，优先级低于方案 A。

---

## 五、风险与边界

| 风险 | 现状 | 处置 |
|---|---|---|
| CLI 版本演进导致 proto/RPC 漂移 | 当前 2026.11.19 已验证 | 在 `lib/compatibility.js` 之外单独加 CLI 版本门禁 |
| mTLS | `CURSOR_MTLS_CERT_DIR` 未设置时不激活 | 包装器检测该变量：设置时透传并在控制台提示冲突 |
| `AGENT_CLI_CREDENTIAL_STORE=file` | 启动器会跳过 `--use-system-ca` | 依赖 `NODE_EXTRA_CA_CERTS` 兜底 |
| Windows / Linux 证书信任 | macOS 依赖系统钥匙串；其他平台行为未验证 | 包装器统一注入 `NODE_EXTRA_CA_CERTS`；Linux 需验证 NSS/系统 CA |
| CLI 会话与 IDE 会话共用 `bridge.db` | 已验证会话正常写入 | 控制台按会话来源区分展示（待实现） |
| CLI 会改写 `~/.cursor/cli-config.json` 的默认模型 | 实测已发生（`--list-models` / `-p` 后默认模型变为桥接 hash） | 包装器不干预；文档提示用户用 `/model` 切回，或显式传 `--model` |
| `persist` 独立会话进程 | `persist list` 已验证透传；独立会话进程未实测 | 预期继承父进程环境，后续补测 |
| 非 Cursor 域名 | 代理直通、不 MITM | 无影响 |

---

## 六、建议的落地顺序

1. ~~薄封装~~（0.2.33 已完成）：`lib/cursor-agent.js` 生成 `cursor-agent-bridge`，supervisor 同步写出 `agent-env`；
2. ~~版本门禁~~（0.2.33 已完成）：独立于 Cursor IDE 的 `2026.11.19` 实测范围；
3. ~~控制面~~（0.2.33 已完成）：控制台「cursor-agent 接管」卡片与 `/api/cursor-agent`，安装/移除包装器、复制启动命令；
4. ~~文档~~（0.2.33 已完成）：README 3.10 与本报告；
5. **补测剩余边界**：`persist` 独立会话进程、后台子代理、Windows / Linux（尤其 Linux 的 CA 信任路径，NSS 与系统 CA 两套）。

---

## 七、复现命令汇总

```bash
# 1. 读取代理端口
cat ~/.config/magpie-cursor-bridge/status.json | grep proxy

# 2. 验证 MITM 与 CA
curl -v --proxy http://127.0.0.1:58160 \
  --cacert ~/.config/magpie-cursor-bridge/data/ca/ca.crt \
  https://agentn.global.api5.cursor.sh/

# 3. 验证模型目录
HTTPS_PROXY=http://127.0.0.1:58160 cursor-agent --list-models

# 4. 验证对话链路
HTTPS_PROXY=http://127.0.0.1:58160 cursor-agent -p --trust --model <hash> '只回复：收到'

# 5. 观察引擎日志
tail -f ~/.config/magpie-cursor-bridge/engine.log
```
