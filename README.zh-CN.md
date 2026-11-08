<div align="center">

# scriptpeek

**装之前，先看清这份 npm lockfile 会执行什么 —— 一条零依赖命令，审计全部生命周期脚本。**

[![CI](https://github.com/ecoreal/scriptpeek/actions/workflows/ci.yml/badge.svg)](https://github.com/ecoreal/scriptpeek/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node: >=18.17](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](./package.json)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)
[![tests: 59 passing](https://img.shields.io/badge/tests-59%20passing-brightgreen.svg)](https://github.com/ecoreal/scriptpeek/actions/workflows/ci.yml)

[English](./README.md) | [中文](./README.zh-CN.md)

</div>

`scriptpeek` 是一个 npm 供应链卫生工具。它在执行 `npm ci` / `npm install`
之前读取 `package-lock.json`，回答一个问题：**哪些包会执行生命周期脚本
（`preinstall` / `install` / `postinstall` / `prepack`）、真实命令原文是什么、
经由哪些依赖路径被引进来 —— 以及相对于上次你信任的那份 lockfile，发生了什么变化。**

- **零依赖。** 仅用 Node.js 标准库；要求 Node ≥ 18.17，ESM（`"type": "module"`）。
- **只读。** 不安装任何东西，不执行任何包的脚本。
- 每个子命令都支持 **`--json`**，schema 稳定，面向机器消费。

## 效果一览

以下均为在本仓库测试 fixtures（一份含 7 个包的 lockfile：3 个声明安装脚本，
4 个没有 `hasInstallScript` 标记、以 unknown 列出）上的真实运行记录：

```console
$ scriptpeek scan
scriptpeek scan — package-lock.json (lockfileVersion 3)
7 of 7 package(s) declare or may run lifecycle install scripts:

Package         Scripts  Registry            Dependency path
--------------  -------  ------------------  ------------------------------------------------------------
alpha@1.0.0     unknown  registry.npmjs.org  fixture-app > alpha
beta@1.0.0      unknown  registry.npmjs.org  fixture-app > beta
devonly@1.0.0   yes      registry.npmjs.org  fixture-app > devonly
postcorg@1.5.0  yes      registry.npmjs.org  fixture-app > beta > postcorg
shared@0.9.0    unknown  registry.npmjs.org  fixture-app > alpha > shared
shared@1.0.0    unknown  registry.npmjs.org  fixture-app > beta > shared | fixture-app > toolkit > shared
toolkit@2.0.0   yes      registry.npmjs.org  fixture-app > toolkit

note: 4 package(s) carry no hasInstallScript flag (lockfile v1 keeps none; v2/v3 can lose it, see npm/cli#2606); they are listed as "unknown" and are never silently skipped. Run "scriptpeek scripts" to fetch the actual script text.

$ scriptpeek diff lockfile.baseline.json
scriptpeek diff — lockfile.baseline.json -> package-lock.json

Type                  Severity  Package        Change
--------------------  --------  -------------  ----------
added-script-package  high      sneakyinstall  new: 2.0.0

summary: 1 added script package(s), 0 version change(s), 0 registry change(s)
exit: 1
```

## 安装

```bash
npx scriptpeek scan
```

一行即可运行，不改动任何项目文件。想全局可用：

```bash
npm install -g scriptpeek
```

## 用法

`scriptpeek` 有四个子命令。每个子命令都接受 `--json` 输出机器可读结果；
`scriptpeek --help` 打印完整概览：

```console
$ scriptpeek --help
scriptpeek — See what an npm lockfile will run before you install it.

Usage:
  scriptpeek <command> [options]

Commands:
  scan                  List every package in package-lock.json that will run lifecycle scripts.
  scripts               Fetch real preinstall/install/postinstall/prepack text from the registry.
  diff <old> [new]      Diff two lockfiles for script-related changes (new defaults to package-lock.json).
  explain <package>     Show every dependency path from the project root to a package.

Common options:
  --json                Emit machine-readable JSON (stable schema).
  --lockfile <path>     Lockfile to read (default: package-lock.json).
  -h, --help            Show help (general or per command).
  --version             Print the version.

Exit codes:
  0  clean
  1  risk found or usage error
  2  input missing or failed to parse

Run "scriptpeek <command> --help" for command-specific options.
```

### `scriptpeek scan [--json] [--lockfile <path>]`

读取 lockfile（支持 lockfileVersion 1/2/3），列出所有会执行生命周期脚本的包，
每条含 `包名@版本`、resolved registry 域、从 root 到该包的全部依赖路径。

判定依据是 lockfile 自带的 `hasInstallScript` 标记。npm 从不写 `false` ——
且 [npm/cli#2606](https://github.com/npm/cli/issues/2606) 会让脚本包在 lockfile
中彻底丢失该标记（npm 7 至 9.x 均有报告，esbuild/electron 一类包是典型案例）。
因此状态无法判定的包以 **unknown** 列出，而不是被跳过 —— 可能执行脚本的包
绝不静默过滤；真实脚本内容可用 `scriptpeek scripts` 从 registry 求证。

### `scriptpeek scripts [--cache-dir <dir>] [--offline] [--registry <url>]`

为 `scan` 列出的每个包抓取 packument，提取真实的
`preinstall` / `install` / `postinstall` / `prepack` 命令原文。
默认 registry 域遵循 lockfile 内各包的 resolved URL；结果写入缓存目录
（默认 `.scriptpeek-cache/`），命中缓存时不再发起任何网络请求。

- `--offline` — 只用缓存。无缓存的包标注为 **unavailable**，明示
  "no script text available"（未取得脚本文本）并保留 lockfile 自身的标记；命令仍退出 0。
- `--registry <url>` — 为所有包覆盖 registry 基地址。
- 抓取失败（HTTP 错误、超时、响应异常）按包降级为说明性 note，绝不中断整次运行。

### `scriptpeek diff <old-lockfile> [new-lockfile] [--json] [--no-fail]`

对比两份 lockfile，报告且仅报告三类事件：

| 事件                   | 含义                                        | 严重度   |
| ---------------------- | ------------------------------------------- | -------- |
| `added-script-package` | 此前不存在、且会执行安装脚本的包             | high     |
| `version-change`       | 已有包的安装版本发生变化                      | high/low |
| `registry-change`      | 已有包的 resolved registry 域发生变化         | high     |

「新增脚本包」是最典型的投毒信号，因此默认退出码 **1**（CI 门控）；
`--no-fail` 强制退出 **0**。省略 `<new-lockfile>` 时默认取
`./package-lock.json`，所以 `scriptpeek diff lockfile.baseline.json` 即可拿
基线对比当前依赖树。

### `scriptpeek explain <package> [--json] [--lockfile <path>]`

打印从项目 root 到该包的全部依赖路径 —— 多条全列，包括在不同嵌套层级安装的
多个版本。依赖环会被剪断（每条路径内节点至多出现一次），输出必然终止。
包不在 lockfile 中时退出码 1。

## 它扫描什么

- **输入** —— 一份 `package-lock.json`（lockfileVersion 1/2/3），纯只读。
  不安装、不执行；无论你自己的还是别人的包脚本，都绝不运行。
- **纳入审计的生命周期脚本** —— 恰好是 npm 在安装时会执行的那四个字段：
  `preinstall`、`install`、`postinstall`、`prepack`。
- **判定来源** —— npm 自己写入的 `hasInstallScript` 标记。npm 只在为 true 时
  写入、从不写 `false`，且该标记可能整体丢失
  （[npm/cli#2606](https://github.com/npm/cli/issues/2606)）；因此没有该字段的
  条目一律列为 `unknown`，绝不静默跳过。只有显式的 `hasInstallScript: false`
  才排除一个包。
- **registry 脚本原文** —— `scripts` 抓取 packument 并提取那四个字段的真实
  命令文本；结果落盘缓存，重跑可完全离线。
- **变更检测范围** —— `diff` 关注三类：新增脚本包、安装版本变化、
  resolved registry 域变化。
- **`devDependencies` 同样计入** —— `npm ci` 会安装并执行它们的脚本。

刻意**不做**的事：它不是恶意软件分析器、不是漏洞数据库、也不是沙箱。
它只把"这份即将安装的 lockfile"的事实摆给你看 —— 专业工具的分工见
[Why：与现有方案对比](#why与现有方案对比) 一节。

## 退出码约定

| 码 | 含义                                                             |
| -- | ---------------------------------------------------------------- |
| 0  | 干净                                                             |
| 1  | 发现风险（diff：新增脚本包；explain：未找到该包）或用法错误        |
| 2  | 输入缺失或解析失败（lockfile 缺失 / 非法 JSON / 不支持的版本号）   |

## JSON schema

每个子命令都接受 `--json`，输出单个 JSON 文档，字段集合稳定
（测试套件以 schema 快照断言保证）：

```jsonc
// scan
{
  "tool": "scriptpeek",
  "version": "0.1.0",
  "command": "scan",
  "lockfile": "package-lock.json",
  "lockfileVersion": 3,
  "projectName": "your-app",
  "packages": [
    {
      "key": "node_modules/toolkit",
      "name": "toolkit",
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/toolkit/-/toolkit-2.0.0.tgz",
      "host": "registry.npmjs.org",
      "hasInstallScript": true,
      "pathsTruncated": false,
      "dependencyPaths": [["your-app", "toolkit"]]
    }
  ],
  "summary": { "totalPackages": 7, "listedPackages": 7, "scriptPackages": 3, "unknownScriptPackages": 4 }
}
```

`scripts` 在每条结果上附加 `source`（`registry` | `cache` | `unavailable`）、
`scripts`（提取到的命令原文）与 `note`（恒存在，无异常时为 null）。
`diff` 输出 `events`（`{type, name, severity, from, to}`）与 `exitCode`
（`from`/`to` 可为 `null`，例如 resolved 被改指 `file:` 本地 tarball）；
`explain` 输出 `found`、`isScriptPackage` 与含 `paths` 的 `matches`。
`pathsTruncated` 标记因枚举上限被截断的路径列表。

## 判定原理

- npm 仅在包声明安装脚本时向 lockfile 写入 `hasInstallScript: true`，
  **从不写 `false`**（arborist 的 lockfile 写入端会跳过 falsy 字段）。
- 因此字段缺失对应两种截然不同的情形：单纯的"无脚本"编码，以及丢标记 bug
  [npm/cli#2606](https://github.com/npm/cli/issues/2606) —— 自 2021 年至今
  开放、npm 7 至 9.x 均有报告，从 v1 升级的 lockfile 中 esbuild/electron
  一类脚本包深受其害。scriptpeek 把缺失标记视为 **unknown** 并列出这些包；
  只有显式的 `hasInstallScript: false` 才是权威结论。真实 lockfile 上会出现
  大量 `unknown` 行 —— 这正是"可能执行脚本的包绝不静默跳过"的代价。
  `scripts`（可缓存、可离线）负责把 unknown 求证清楚。
- 依赖路径基于安装树构建依赖图求得，依赖解析遵循 npm 的最近
  `node_modules` 上溯规则（无需 semver 范围运算：布局已由 lockfile 固定）。
  路径枚举设有每包上限 —— 见[边界与限制](#边界与限制)。

## Why：与现有方案对比

多数工具回答的是与 scriptpeek 不同的另一个问题。下表是对各工具在其写作时点
公开文档所述核心定位的中性归纳 —— 它们解决的问题不同，彼此可以互补；
采用前请以各项目当前文档为准。

|                                     | scriptpeek                                  | `npm audit`                  | lockfile-lint                       | `@lavamoat/allow-scripts`                | Socket (socket.dev)                    |
| ----------------------------------- | ------------------------------------------- | ---------------------------- | ----------------------------------- | ---------------------------------------- | -------------------------------------- |
| 核心问题                            | 哪些包会执行安装脚本 —— 具体执行什么          | 依赖树里有没有已知 CVE        | lockfile 的 resolved URL 是否合规     | 哪些安装脚本应被允许执行                   | 是否存在行为恶意的包                     |
| 运行位置                            | 本机纯 CLI                                   | 纯 CLI，随 npm 自带           | 本机纯 CLI                           | 嵌在项目自身的 npm install 流程里          | CLI，背后依赖 Socket 云服务              |
| 是否需要网络                         | `scan`/`diff`/`explain`：否；`scripts`：可选（可缓存，支持 `--offline`） | 是（查询漏洞公告库） | 否 | 否 | 是 |
| 安装前展示真实脚本命令原文            | 是 —— 从 registry 抓取、落盘缓存、可离线      | 否                           | 否                                  | 在 install 过程中记录进其策略文件          | 行为信号，不以脚本文本为核心             |
| 两份 lockfile 对比作 CI 门控          | 是 —— `diff` 遇新增脚本包退出码 1             | 否                           | 否                                  | 否（改为基于策略文件）                     | 经由其平台告警                          |
| 额外负担                             | 零依赖，无需其他配置                         | 无                           | 多一个 CLI 工具                      | 安装流程 + 策略文件集成                    | 需要账号与 API 访问                      |

scriptpeek 的定位：一个零依赖、只读的装前检查，直接作用于 lockfile 本身 ——
包括那些不希望（或不能）额外安装东西的环境，以及"这些安装脚本会在本机执行
什么"这个具体问题。

## 建议 CI 门控

```bash
scriptpeek diff lockfile.baseline.json
```

把已知良好的 lockfile 作为基线提交；一旦有新的脚本包混入，diff 直接让任务失败。
同一任务里再跑 `scan` / `scripts` 得到完整装前清单，`registry-change` 事件建议人工复核。

## 边界与限制

- **`hasInstallScript` 缺失意味着 unknown，而不是干净** —— 见
  [npm/cli#2606](https://github.com/npm/cli/issues/2606)。scan 会列出每一个
  这样的包，因此真实 lockfile 的输出会包含大多数包；请用
  `scriptpeek scripts` 求证 unknown（`--offline` + 缓存适配完全断网环境）。
- **依赖路径枚举设有上限**：每包最多 1000 条简单路径（以 `pathsTruncated:
  true` 标记，DFS 前缀顺序）。无上限枚举的代价可实测：7 层 × 8 宽的全连接
  DAG 对单个包就产生 262,144 条路径；上限把该形态下的 `scan --json` 压到
  约 4 MB、毫秒级完成。标记被置位时请人工复核截断清单。
- `diff` 按包名匹配；同一包的多个安装版本折叠为一组比较（版本集合以逗号连接展示）。
  `registry-change` 同样覆盖源变为/来自无域 URL 的情况（`from`/`to` 可为
  `null`，例如 resolved 被改指 `file:` 本地 tarball）。
- v0.1 不遍历 workspace 布局（`packages/*` link 条目）。
- `scripts` 默认经 HTTPS 抓取 packument；完全断网环境请使用 `--offline`
  加预先预热好的 `--cache-dir`。

## 开发

```bash
git clone https://github.com/ecoreal/scriptpeek
cd scriptpeek
npm test
```

无需安装步骤 —— 项目零依赖，`npm test` 即无参数 `node --test`
（Node ≥ 18.17），完全离线，仅用合成 fixtures。测试直接 spawn 真实 CLI，
packument 来自 `127.0.0.1` 上的本地 `node:http` mock registry，缓存一律放在
`mkdtemp` 临时目录 —— 不访问网络，不读写真实用户目录。

```console
$ npm test
...
ℹ tests 59
ℹ suites 0
ℹ pass 59
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

代码结构：`bin/scriptpeek.js`（入口）→ `src/cli.js`（argv 解析、帮助文本、
分发、退出码）、`src/lockfile.js`（读取并归一化 v1/2/3）、`src/graph.js`
（依赖路径）、`src/scripts.js`（registry 抓取、缓存、离线）、`src/diff.js`
（事件模型）、`src/report.js`（人类可读表格 + `--json`）。
欢迎参与贡献 —— 见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## Roadmap

以下是意向而非承诺 —— 0.1.0 均未实现。欢迎反馈与 PR。

- [ ] 依赖图遍历 workspace / link 条目（当前跳过 —— 见[边界与限制](#边界与限制)）。
- [ ] `diff` 支持允许清单：忽略你已人工复核过的脚本包，使基线对比只标记
      真正的新增者。
- [ ] 提供预热脚本缓存的便捷命令，供断网 CI 在联网机器上先行预热。
- [ ] 探索对其他 lockfile 格式（`pnpm-lock.yaml`、`yarn.lock`）做同样的
      脚本审计。

## 许可证

[MIT](./LICENSE) © 2026 Jerry Lee (ecoreal)
