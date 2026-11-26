# Cursor死忠粉福利！magpie + cursor-bridge 实现Cursor接入任意第三方模型

Magpie：https://github.com/nodlles/magpie

插件：https://github.com/kingchen95272025/magpie-agent-cursor-bridge-enhanced

Cursor 好用，但模型菜单基本被官方订阅锁死。想把 DeepSeek、Kimi、Qwen 这些更划算的模型接进来，又不想动 Cursor 本身，可以试试 Magpie 加这个桥接插件。普通版 Cursor 也能用，不用升级订阅。

Magpie 是一个本地模型管家：把各家供应商的 Key 和模型统一收进来，再通过本机网关交给 Cursor。Cursor 这边只需要装一个插件，登录、Tab 补全都保持原样。它还能把多个模型做成一个路由组，某个模型额度用完时自动切到备用。

用法不复杂：

1. 安装 Magpie，在「供应商」里添加自己的模型；
2. 在 Magpie 插件页安装 magpie-agent-cursor-bridge-enhanced；
3. 到「Agents」里给 Cursor · Magpie Bridge 选模型；
4. 从左侧栏「Cursor 桥接控制台」打开控制台，启动并重启 Cursor。

![在 Magpie 里添加供应商](https://raw.githubusercontent.com/kingchen95272025/magpie-agent-cursor-bridge-enhanced/master/docs/images/magpie-provider-add.png)

![在 Agents 里连接 Cursor Bridge](https://raw.githubusercontent.com/kingchen95272025/magpie-agent-cursor-bridge-enhanced/master/docs/images/magpie-agents.png)

控制台可以启动、停止、重启，也能改模型显示名、隐藏不用的模型、查看最近调用和日志。3.32.5 及以下版本已实测可用。

![Cursor 桥接控制台](https://raw.githubusercontent.com/kingchen95272025/magpie-agent-cursor-bridge-enhanced/master/docs/images/console-overview.png)

更完整的 Magpie 供应商维护、控制台与故障排查：https://github.com/kingchen95272025/magpie-agent-cursor-bridge-enhanced/blob/master/docs/plugin-usage.md

项目地址：

Magpie：https://github.com/nodlles/magpie

插件：https://github.com/kingchen95272025/magpie-agent-cursor-bridge-enhanced
