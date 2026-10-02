# JevRev

<p align="center">
  <img src="../.github/assets/jevrev-banner.png" alt="JevRev 字标与插画" width="620" />
</p>

<p align="center"><strong>给 LLM 一个 Jev 做的合金脊柱</strong></p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="最新版本" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square&amp;color=555555&amp;labelColor=333333" /></a>
  <a href="../package.json"><img alt="需要 Node.js 20 或以上版本" src="https://img.shields.io/badge/Node.js-%3E%3D20-555555?style=flat-square&amp;labelColor=333333" /></a>
  <a href="../LICENSE"><img alt="MIT 许可" src="https://img.shields.io/badge/License-MIT-555555?style=flat-square&amp;labelColor=333333" /></a>
</p>

<p align="center">
  快速跳转：<a href="#来吧展示">案例</a> · <a href="#对三个部分更详细的阐述">Sift / Loop / Long</a> · <a href="#快速上手接入任意-agent">接入 Agent</a> · <a href="#tui人的驾驶舱">TUI</a> · <a href="#接入-jev-或本地模型">模型</a> · <a href="#文档">文档</a>
</p>

JevRev 是一个 LLM+Jev 的系统。正如进化了千年的动物把自己逼出了脊椎用于以极快的速度和极低的成本完成大量决策一样，JevRev 把 LLM 的思考深度高、效益好但是响应慢、成本高的特点与 Jev 的极快响应速度、极低输出成本的特点相结合，达成了对 workflow 非常好的优化效果。

这个工具主要有三个部分：**JevSift**，**JevLoop** 和 **JevLong**。

它会在一个任务开始的时候让 LLM 发散出去，像一个八爪鱼一样摊开——看看哪个触手能碰到正确而最合适的方案，然后裁剪掉有问题的和效果不合预期的触手，这就是 JevRev 中的 **JevSift**。而 **JevLoop** 可以让 agent 在 loop 中完成每轮次的工作后被审计、打分，根据效果继续进行下一轮。Jev 的参与大大提高了效率，也极大降低了成本，甚至最后成果惊人。我们会在接下来的文档中附上案例。**JevLong** 可以作为一个监视器，注意那些长时间、多轮次的任务有没有出现提示卡住、重复失败、方向漂移、工具调用异常和预算风险。

过程中，Jev 就是一个旁观的角色。它会给出决策、筛选和提醒，不会提出方案和执行——那是 LLM 干的活。它是 CLI 和 JSON 协议，不是另一个 coding agent，也不会接管你的会话。


## 来吧，展示

接下来有几个示例，直观展示 JevRev 能带来多大的变化。

### 1. Tidal City （这个请一定要看）

<details>
<summary>点击展开案例：TidalCity 的实现</summary>

使用相同的模型 ChatGPT-6-Sol-Ultra 运行同一套提示词以构建 TidalCity ，一个会被潮水淹没的城市模拟。以下是没有 Jev 干涉的 BenchMark 版本：

<p align="center">
  <img src="../.github/assets/tidal-city/benchmark-01.jpg" alt="Tidal City benchmark 1" width="49%" />
  <img src="../.github/assets/tidal-city/benchmark-02.jpg" alt="Tidal City benchmark 2" width="49%" />
</p>

可以看见有一些简单的房屋、道路和一定程度潮水上涨之后的模拟。但是模型简陋、操控单一、道路和房屋是随机放置相连，没有逻辑的。

以下是使用了 JevRev（包括 JevSift、JevLoop 和 JevLong）的成果：

<p align="center">
  <img src="../.github/assets/tidal-city/jevrev-01.jpg" alt="Tidal City with JevRev 1" width="100%" />
</p>
<p align="center">
  <img src="../.github/assets/tidal-city/jevrev-02.jpg" alt="Tidal City with JevRev 2" width="49%" />
  <img src="../.github/assets/tidal-city/jevrev-03.jpg" alt="Tidal City with JevRev 3" width="49%" />
</p>
<p align="center">
  <img src="../.github/assets/tidal-city/jevrev-04.jpg" alt="Tidal City with JevRev 4" width="49%" />
  <img src="../.github/assets/tidal-city/jevrev-05.jpg" alt="Tidal City with JevRev 5" width="49%" />
</p>

可以看到城市规模变大，很好地完成了材质的建设。城市内容丰富生动，有不同分区，甚至每一个建筑都有自己的名字。可以切换不同时间、可以切换不同视角，也可以选择漫游模式使用 wasd 在城市中漫游或者水中游泳。
</details>

### 2. JSONL 事件摄取

<details>

<summary>点击展开案例：25,000 条 JSONL 事件处理</summary>

让一个纯 Node 20 的 JSONL 摄取器处理 25,000 条生产形状事件，同时满足：
 - 坏行隔离；
 - 保留首次出现顺序；
 - 重复事件只输出一次；
 - 吞吐目标至少达到保守 baseline 的 2 倍。

 输入约 2.3 MB，包含 184 条 malformed/schema-invalid 行和 258 个重复 ID。

**JevSift做了什么：**

六个方向进入筛选，JevSift 留下两个严格 survivor，另有一个 review：

| 方案 | Sift 分数 | 结果 |
| --- | ---: | --- |
| `batch-index` | 0.9243 | 保留，进入真实 probe |
| `regex-shortcut` | 0.9240 | 保留，进入真实 probe |
| `state-scan` | 0.7965 | 预算截断 |
| `baseline-parse` | 0.6100 | 执行价值低，拒绝 |
| `worker-shards` | 0.6043 | review，未被默认为通过 |
| `external-index` | 0.4931 | 执行价值低，拒绝 |

两个 survivor 都执行了正确性检查和 7 次 benchmark。结果是：

| 指标 | `regex-shortcut` | `batch-index` |
| --- | ---: | ---: |
| 正确性 | 失败，expected 184 / actual 65 | 通过 |
| 平均吞吐（events/s） | 180,530.90 | 180,317.21 |
| 样本标准差（n-1） | 8,567.37 | 10,486.05 |
| Decide | rejected | `winner` |

普通的未决策工作流会选 regex；它速度很漂亮，但无法处理全部 malformed 行。
JevRev最后选择的 `batch-index`，不是因为Jev觉得它更快，
而是它满足了任务契约。

**JevLoop做了什么：**

1. 第 1 轮：吞吐通过，但 correctness 失败，返回 `fix_regression`。
2. 第 2 轮：新鲜 correctness 和维护性证据通过，返回 `verify`。
3. 第 3 轮：同一 head 上重新提交全部标准和 protected surface，返回 `completed`。

最终状态：`completed`，第 3 轮，记录墙钟 838 ms，replay provider accounting 为
1,628 tokens。

**JevLong做了什么：**

- 首次接收 13 个事件；重复导入接收 0 个、识别 13 个 duplicate；
- `long status`、多帧 `long watch` 和 `long loop-audit` 均执行；
- 最终 sequence 为 14；
- 报告 `failure_loop` 高等级告警和 `protocol` critical 告警；
- Loop 是 completed，但 Long 的 `progress_index` 仍为 0。

</details>

## 对三个部分更详细的阐述

<picture>
  <source media="(max-width: 600px)" srcset="../.github/assets/jevrev-product-roles-mobile.svg">
  <img src="../.github/assets/jevrev-product-roles.svg" alt="JevSift 选路线，JevLoop 复核一个成果，JevLong 观察长跑会话" />
</picture>

### JevSift：先决定试什么

LLM 先写出几张真正不同的方案卡。JevSift 用 Jev 做窄问题判断，再由确定性的策略去重、过滤硬约束风险，并为留下的方案生成有预算和停止条件的 probe work order。

Sift 的作用是回答哪些方向值得你的token。真正的代码、测试和 benchmark 仍由宿主 agent 执行。

如果说不准任务是否值得开一轮 Sift ，可以先跑 shadow activation：

```bash
jevrev activation --input activation.json --format json
```

它比较走错路线的预计代价和几次 bounded probe 的代价，输出稳定的 reason code。当前是 shadow-only：不会调用 Jev，不会替你启动或跳过 Sift。字段和后续评估计划见 [activation policy](ACTIVATION.md)。

### JevLoop：让每一轮的成果在证据里收敛

Agent 每轮推进工作，JevLoop 每轮检查结果。它读取 recorder 提交的命令、测试、指标与产物，先确认哪些事实已经发生，再让 Jev 判断当前成果离目标还差什么，输出下一步动作：`fix`、`verify`、`continue`、`replan` 或 `human`，直到目标真正满足。

Loop 只跟踪一个成果。agent 负责行动，Loop 负责复核，Jev 负责判断。它不接管会话，也不会给只是看起来不错的成果盖章；每一次完成，都必须由可重放的证据证明。

### JevLong：让长跑会话保持可见、可审计

Long 持续读取 agent 写入的 JSONL 事件，记录会话进展，并识别卡住、重复失败、方向漂移、工具异常和预算风险。它只负责如实呈现和监测过程，把“发生了什么、是否仍在前进、风险在哪里”及时呈现出来。

```bash
jevrev long watch --directory .jevrev/long
jevrev long status --directory .jevrev/long --format json
```

## 快速上手：接入任意 Agent

JevRev 通过 CLI、JSON 和 JSONL 与外部 agent 连接。Codex、Claude Code、OpenCode、CI 流程和自建 harness 都可以使用同一套协议；支持 skill 的宿主加载说明文件，其他宿主直接调用 CLI 即可。

### 安装

```bash
npm install
npm run build
node scripts/install-skill.mjs --target <codex|claude|agents|dsh>
```

根据宿主选择一个 `target`；OpenCode 或其他自定义宿主使用
`--destination <host-skill-directory>`。

给 Agent 的 prompt 示例：

```text
请用 JevRev：完成这个任务并运行 Sift，只执行入选方案，记录证据，每轮交给 Loop，长任务接入 Long。
```

马上运行完整示例：

```bash
npm run demo:workflow
```

## TUI：人的驾驶舱

在交互终端直接运行 `jevrev` 就会打开驾驶舱，不需要先创建 Long。Sessions
同时显示 JevRev 组件会话，以及通过命令注册的 Codex、Claude Code、OpenCode
等宿主会话：

```bash
jevrev session register --host codex --session-id <id> --title "..." --goal "..."
jevrev session list
```

Claude Code 使用 `--host claude`；也支持 OpenCode 和自定义宿主。注册只保存会话
元数据，不读取宿主的私有 transcript。

选择会话后进入 **Kanban / Monitor**。页面顶部的 Loop 和 Long 开关会保存到
该会话，并显示 observer store 是否就绪。开关不会启动观察器或接管宿主 agent。

| 页面 | 内容 |
| --- | --- |
| Sessions | 已注册的宿主会话和 JevRev 组件会话 |
| Kanban / Monitor | 工作进展、证据、风险及 Loop / Long 开关 |
| Config | 自动打开、刷新间隔和终端颜色 |

使用 ↑ / ↓ 选择会话、Enter 打开；使用 `l` / `o` 选择监测项，再按 `Space` 切换。
也可以使用 CLI 修改开关：

```bash
jevrev session monitor --id <jevrev-session-id> --loop on --long on
```

组件命令成功后可自动打开驾驶舱并聚焦刚更新的会话。使用
`jevrev --no-tui ...` 或设置 `JEVREV_NO_TUI=1` 可关闭自动打开。没有交互终端时，
JevRev 保持普通 human/JSON 输出，不发送 TUI 控制字符。

## 接入 Jev 或本地模型

Sift、Decide 和 Loop audit 共用同一套 provider 接口，可以连接云端 Jev、本地 SemIf，或使用 replay 文件离线运行。不要把凭据写进命令参数、campaign、evidence 或版本控制。

### 首次配置

在交互终端中运行 `jevrev` 或 provider 相关命令时，如果当前云端 provider
尚无 key，会出现配置表单。选择 `jev`、`local` 或 `semif`，填写地址及 Jev
所需的 key，按 Enter 保存。输入时 key 被遮蔽，但保存的 key 是**明文，未加密**：

- Windows：`%APPDATA%/jevrev/config.json`，未设置时使用 `~/AppData/Roaming`。
- macOS：`~/Library/Application Support/jevrev/config.json`。
- Linux：`$XDG_CONFIG_HOME/jevrev/config.json`，未设置时使用 `~/.config`。

可用 `JEVREV_CONFIG_PATH` 指定其他文件。非空环境变量优先于保存值；显式 CLI
选项优先于地址和 provider 默认值。仅使用环境变量或 replay 时，用
`jevrev --no-tui ...` 或 `JEVREV_NO_TUI=1` 跳过表单。管道命令及
`--help` / `--version` 不弹出表单。Esc 退出表单且不保存，随后仍会执行原命令；
若仍需要 key，命令可能失败。参见[配置与重置说明](CONFIGURATION.md)。下方云端
示例使用环境变量，不保存 key。

### 云端 Jev

macOS / Linux：

```bash
export JEVREV_JEV_API_KEY="..."

node dist/cli.js sift \
  --input examples/parser-speedup.json \
  --provider jev \
  --output campaign.json
```

Windows PowerShell：

```powershell
$env:JEVREV_JEV_API_KEY = "..."

node dist/cli.js sift `
  --input examples/parser-speedup.json `
  --provider jev `
  --output campaign.json
```

自定义 Jev API 地址时，可设置 `JEVREV_JEV_URL`，或传入
`--jev-url <api-root>`。CLI 会向该地址的 `/v1/systemone` 发送请求。

### 本地 SemIf

Windows：

```powershell
powershell -ExecutionPolicy Bypass `
  -File scripts/start-semif.ps1 -Background

node dist/cli.js sift `
  --input examples/parser-speedup.json `
  --provider semif `
  --output campaign.json
```

本地模型的启动、检查和停止方式见
[`SEMIF_LOCAL.md`](SEMIF_LOCAL.md)。



## 文档

- [TUI 设计](TUI_DESIGN.md)
- [工作流](WORKFLOW.md)
- [activation policy](ACTIVATION.md)
- [协议与 JSON 契约](PROTOCOL.md)
- [权限模型](AUTHORITY.md)
- [JevLoop 设计](JEVLOOP_DESIGN.md)
- [JevLong 设计](JEVLONG_DESIGN.md)
- [验收记录](ACCEPTANCE.md)

JevRev 使用 MIT 许可。

[MIT](../LICENSE)
