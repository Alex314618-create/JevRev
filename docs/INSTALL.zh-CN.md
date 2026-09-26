# JevRev 安装与使用

## 环境要求

- Git
- Node.js 20 或更新版本，并包含 npm
- Windows 使用 PowerShell 或命令提示符；macOS/Linux 使用 Bash、Zsh 等 shell

JevRev 的 CLI、Sift、Loop、Long、replay provider 和云端 Jev provider 在
Windows、macOS、Linux 上使用同一套 Node.js 程序。

## 从仓库安装

目前 `jevrev` 尚未发布到 npm 公共 registry。请从 GitHub 源码仓库安装：

```text
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm ci
npm run build
node dist/cli.js --version
npm run demo
```

这个 demo 使用仓库里的 Jev replay 回答，不需要 API key，也不需要连接
模型服务。

### 将 `jevrev` 安装成全局命令

在 JevRev 仓库目录运行：

```text
npm link
jevrev --version
```

`npm link` 建立的是指向当前 checkout 的全局链接，不会发布或复制程序，
不要移动或删除这个 checkout。若新终端里找不到 `jevrev`，检查 npm 的全局
可执行目录是否在 `PATH` 中，并重新打开终端。`npm prefix -g` 可以显示全局
目录：Windows 的命令 shim 位于该目录；macOS/Linux 通常位于其 `bin` 子目录。

也可以不建全局链接，直接在仓库中使用 `node dist/cli.js`。

## 不用 API key 先跑一遍

在仓库目录中运行：

```text
node dist/cli.js activation --input examples/activation-parser.json
node dist/cli.js sift --input examples/parser-speedup.json --replay examples/parser-jev-response.json
npm run demo:workflow
npm run demo:loop
npm run demo:engineering
```

`activation` 是本地 shadow 判断；replay 命令会跑 Sift，但不会请求 Jev。
workflow demo 会真实执行 probe 和证据检查，Jev 的判断使用录制结果以保证
每次演示可复现。

处理真实任务时，把 Sift 请求保存为 JSON：

```text
jevrev sift --input proposals.json --provider jev --output campaign.json --summary
```

输入既可以是文件，也可以用 `-` 表示标准输入；输出可选 JSON，方便 agent
读取。协议详见 [PROTOCOL.md](PROTOCOL.md)。

## 配置云端 Jev

在当前 shell 设置 `JEVREV_JEV_API_KEY`。不要把 key 放进 CLI 参数、方案文件、
证据文件或版本控制。

PowerShell：

```powershell
$env:JEVREV_JEV_API_KEY = '<你的 key>'
jevrev doctor --format json
jevrev sift --input proposals.json --provider jev --output campaign.json --summary
Remove-Item Env:JEVREV_JEV_API_KEY
```

Bash、Zsh 等 POSIX shell：

```sh
export JEVREV_JEV_API_KEY='<你的 key>'
jevrev doctor --format json
jevrev sift --input proposals.json --provider jev --output campaign.json --summary
unset JEVREV_JEV_API_KEY
```

三种系统使用相同的 CLI 和环境变量名称。

## 安装 agent skill

安装器只复制仓库里的 `SKILL.md`，不会安装 CLI。完成构建后，在 JevRev
仓库目录运行：

```text
node scripts/install-skill.mjs --target codex
node scripts/install-skill.mjs --target claude
node scripts/install-skill.mjs --target opencode
node scripts/install-skill.mjs --target agents
```

`opencode` 会安装到 `~/.config/opencode/skills/jevrev`。`agents` 会安装到
`~/.agents/skills/jevrev`，OpenCode 和其他兼容 Agent Skills 的工具也可以从
这里发现 skill。也可以安装到项目目录：Claude Code 使用
`.claude/skills/jevrev`；OpenCode 及其他兼容工具使用 `.agents/skills/jevrev`。

```text
node scripts/install-skill.mjs --destination .claude/skills/jevrev
```

PowerShell、Bash 和 Zsh 中命令相同。全局目标会使用当前用户的 home 目录；
自定义目标接受对应系统的路径格式。

## 本地模型

CLI 的 HTTP provider 不依赖操作系统。不过仓库附带的 SemIf 模型下载、启动、
停止脚本以及固定模型部署流程目前是 Windows PowerShell 脚本。macOS/Linux
用户可以自行启动兼容的 SemIf 服务，再用 `--semif-url` 指定地址。请求协议和
Windows 设置见 [SEMIF_LOCAL.md](SEMIF_LOCAL.md)。

## 常见问题

- 找不到 `node` 或 `npm`：安装 Node.js 20 或更新版本，然后重新打开终端。
- `npm link` 后找不到 `jevrev`：检查 npm 全局可执行目录是否在 `PATH` 中；也可在 checkout 中运行 `node dist/cli.js`。
- 提示缺少 Jev API key：设置 `JEVREV_JEV_API_KEY`，或先用 `--replay`；本地服务可用 `--provider semif`。
- Skill 能看到但命令运行失败：Skill 和 CLI 是分开安装的；先在该 agent 使用的 shell 中运行 `jevrev --version`。
- SemIf 无法连接：检查服务地址和端口，再运行 `jevrev doctor --provider semif --check`。
