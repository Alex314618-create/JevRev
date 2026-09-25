# JevRev

<p align="center">
  <img src=".github/assets/jevrev-banner.png" alt="JevRev 字标与插画" width="620" />
</p>

<p align="center"><strong>让 LLM 多想几条路，再把时间花在值得走的那条上。</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="最新版本" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square&amp;color=555555&amp;labelColor=333333" /></a>
  <a href="package.json"><img alt="需要 Node.js 20 或以上版本" src="https://img.shields.io/badge/Node.js-%3E%3D20-555555?style=flat-square&amp;labelColor=333333" /></a>
  <a href="LICENSE"><img alt="MIT 许可" src="https://img.shields.io/badge/License-MIT-555555?style=flat-square&amp;labelColor=333333" /></a>
</p>

LLM 很适合发散：它能同时提出几种实现，写出代码，跑测试，再根据结果修改。问题是，很多任务真正贵的地方不在“写第一版”，而在于走错方向之后才发现已经花掉了一轮时间和 token。

JevRev 把 Jev 放在 LLM 旁边，专门做决策。LLM 负责提出方案和执行，JevRev 负责在关键节点筛选、复核和提醒。它是 CLI 和 JSON 协议，不是另一个 coding agent，也不会接管你的 Codex 会话。

## 先跑一个完整例子

仓库里的案例是一个 CSV 解析器提速任务。LLM 提出正则捷径和状态机两条路线。纸面排名更高的正则方案没有通过正确性检查，原本排第二的状态机反而成为最后的证据赢家：

```text
Paper favorite: regex-shortcut
  correctness command: failed
  result: rejected

Evidence winner: indexed-state-machine
  correctness command: passed
Decision: winner -> integrate_winner
```

这不是预先写好的“正确答案”：实现、命令退出码、benchmark 样本和输出摘要都在本地真实运行。Jev 的回答为了让 demo 可重复而使用 replay 文件。

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run build
npm run demo:workflow
```

想看细节，可以直接读[探针脚本](benchmarks/workflow-fixture/probe.mjs)、[demo 驱动](scripts/run-workflow-demo.mjs)和[决策测试](tests/workflow-decide.test.ts)。还有一个从零开始的 JSONL ingestion 案例，记录了错误捷径、三轮 Loop 和 Long 观察结果：[完整记录](benchmarks/real-jsonl-ingestion/README.md)。

## 三个部分

<picture>
  <source media="(max-width: 600px)" srcset=".github/assets/jevrev-product-roles-mobile.svg">
  <img src=".github/assets/jevrev-product-roles.svg" alt="JevSift 选路线，JevLoop 复核一个成果，JevLong 观察长跑会话" />
</picture>

### JevSift：先决定试什么

LLM 先写出几张真正不同的方案卡。JevSift 用 Jev 做窄问题判断，再由确定性的策略去重、过滤硬约束风险，并为留下的方案生成有预算和停止条件的 probe work order。

Sift 的结果是“哪些值得试”，不是“哪个已经正确”。真正的代码、测试和 benchmark 仍由宿主 agent 执行。

如果任务是否值得开一轮 Sift 还说不准，可以先跑 shadow activation：

```bash
jevrev activation --input activation.json --format json
```

它比较走错路线的预计代价和几次 bounded probe 的代价，输出稳定的 reason code。当前是 shadow-only：不会调用 Jev，不会替你启动或跳过 Sift。字段和后续评估计划见 [activation policy](docs/ACTIVATION.md)。

### JevLoop：每轮复核一个成果

Loop 面向一个正在演进的成果。agent 做完一轮后，用 recorder 记录命令、指标和产物，再把 round evidence 交给 Loop。Loop 先检查可验证的事实，再把剩下的窄问题交给 Jev，返回下一步：继续、修复、验证、重新规划、等待人工，或在所有标准都满足后完成。

Loop 不启动 agent，也不替它改文件。`Probe`、`Evidence`、`Decide` 是这条工作流里的基础设施，不是额外的产品组件。

### JevLong：观察长跑会话

Long 从 JSONL 事件中观察一个长时间运行的 agent，提示卡住、重复失败、方向漂移、工具调用异常和预算风险。它只报告，不暗中重试、改方向或结束 agent。

```bash
jevrev long watch --directory .jevrev/long
jevrev long status --directory .jevrev/long --format json
```

非交互终端默认只打印一条紧凑状态；需要持续采样时显式加 `--stream` 或 `--iterations N`。

## 在 Codex 里使用

JevRev 的交互面就是命令行。Codex、Claude Code 或其他宿主 agent 只需在决策点调用 CLI，并把 JSON 文件作为上下游接口：

```text
agent 写出 proposals.json
        -> jevrev sift -> campaign.json 和 probe work orders
agent 执行 probe，记录 evidence.json
        -> jevrev decide 或 jevrev loop audit -> 下一步
agent/适配器发送 JSONL 事件
        -> jevrev long -> 状态和提醒
```

安装仓库里的 skill 可以让 Codex 知道这些调用约定：

```bash
npm install
npm run build
node scripts/install-skill.mjs --target codex
```

然后告诉宿主 agent：

```text
Use JevRev for this task. Propose materially different approaches, ask JevRev
to sift them, run only the bounded probes, record the evidence, and let JevRev
audit the next round before continuing.
```

人仍然在关键位置做决定：定目标和约束、选择 provider、批准恢复或中止 Loop，以及决定是否整合最终成果。JevRev 只返回可检查的工作单、事实和 typed next action，不会在后台继续工作。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `jevrev activation` | 判断当前任务是否值得开 Sift（shadow-only） |
| `jevrev sift` | 从候选方案中选出值得 probe 的路线 |
| `jevrev loop` | 复核一个成果的每一轮进展 |
| `jevrev long` | 观察一个长跑会话的状态 |
| `jevrev evidence` / `jevrev decide` | 记录事实并对 probe 结果做最终裁定 |

从源码运行时，把 `jevrev` 换成 `node dist/cli.js`：

```bash
node dist/cli.js sift --input examples/parser-speedup.json --replay examples/parser-jev-response.json
```

## 接入 Jev 或本地模型

同一套协议可以使用云端 Jev、本地 SemIf，或者 replay 文件。凭据放在环境变量里，不要写进命令参数、campaign 或 evidence：

```bash
export JEVREV_JEV_API_KEY="..."
node dist/cli.js sift --input examples/parser-speedup.json --provider jev \
  --output campaign.json --summary
```

Windows 本地 SemIf：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
node dist/cli.js sift --input examples/parser-speedup.json --provider semif `
  --output campaign.json --summary
```

没有 API key 时可以直接使用仓库中的 replay。具体的本地模型设置见 [`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md)。

## 同一份需求，两种结果

仓库还提供了一个非代码案例：同一份页面需求，一份直接出稿，一份先经过 JevRev 路线筛选并留下验证记录。

<table>
  <tr>
    <th width="50%">常规初版</th>
    <th width="50%">JevRev 路线</th>
  </tr>
  <tr>
    <td><img src=".github/assets/one-shot-showcase/direct-hero.png" alt="常规初版页面" /></td>
    <td><img src=".github/assets/one-shot-showcase/routed-hero.png" alt="JevRev 路线页面" /></td>
  </tr>
</table>

这里不做“视觉分数更高”的空泛承诺。差异在于：选择路线时用的假设、探针和证据都被保留下来，最后的产物因此更容易复查。[案例说明](benchmarks/one-shot-showcase/README.md)和[验证记录](benchmarks/one-shot-showcase/VALIDATION.md)都在仓库里。

## 文档

- [工作流](docs/WORKFLOW.md)
- [activation policy](docs/ACTIVATION.md)
- [协议与 JSON 契约](docs/PROTOCOL.md)
- [权限模型](docs/AUTHORITY.md)
- [JevLoop 设计](docs/JEVLOOP_DESIGN.md)
- [JevLong 设计](docs/JEVLONG_DESIGN.md)
- [验收记录](docs/ACCEPTANCE.md)

## 本地开发

```bash
npm install
npm run check
npm test
npm run build
npm run demo:all
npm run demo:workflow
npm run demo:loop
npm run demo:engineering
```

需要 Node.js 20 或更高版本。JevRev 使用 MIT 许可。

[MIT](LICENSE)
