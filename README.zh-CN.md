<!-- golive-translation: lang=zh-CN; source=README.md; source-commit=0fc6dca; reviewed=false; updated=2026-09-26 -->
# GoLive

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Deutsch](README.de.md)

**教 agent 如何用你自己的账号，把 AI 写出来的产品真正推上线：托管、数据库、认证、域名、邮件、支付。上线之后可以交接，也可以整体拆除。**

你的编码 agent 几分钟就能写出一个应用，但要把它交到真实用户手里，仍然得处理账号、托管、数据库、域名、密钥和一连串外部服务。GoLive 就是为这件事准备的开源 Agent Skill：它会**检测你的应用需要什么、规划出具体要改什么、请你批准、用你自己的登录去执行，并验证哪些是真的生效了** —— 然后记录它创建了什么、需要时重新检查有没有漂移，也能把创建的东西删掉。

凡是服务商开放了接口的部分，就自动化；凡是必须由人来做的部分，就一步步带你走。能被观测到的就验证，没做完的就明说。不需要 GoLive 账号、托管后端，也不收集产品遥测。

> **早期 alpha · 0.1.0-alpha.4**
> 一次性 live 测试现在覆盖六条链路：**托管**（Vercel、Netlify）、**数据库**（Supabase、Neon）、
> **自定义域名 DNS**（Porkbun、GoDaddy）、**事务性邮件**（Resend）、**测试模式支付**（Stripe）
> 和 **Supabase 认证**，外加 `teardown` 卸载路径。归属文档和按需运行的 `golive status`
> 漂移检查已经实现并有测试覆盖（`golive status` 也在一次 live 验证中以只读方式跑过），而更大范围的
> [路线图](README.md#the-full-go-live-checklist-and-roadmap)是我们的方向，不是说这些都建好了。

## 在交出生产环境权限之前

要不要把服务商账号交给 agent，归根结底是四个问题。以下是这个项目自己的答案，凡是存在边界的地方都写清楚了。

- **每一次写入仍然要你批准。** 没有你亲眼看过并批准的计划，任何真实账号都不会被改动：`apply` 缺少该计划的 ID 和 `--yes` 就会拒绝执行，并且写入前会重新核对计划的身份，所以发布版本或配置一变，原先的批准就失效。DNS 写入需要 `--confirm-dns`，删除需要 `--confirm-destroy`，而 live 模式的步骤 —— live 支付、生产数据、真实账号 —— 需要 `--confirm-live`；这条现在也包括一个项目的**首次生产部署**，因为过去仅仅批准一个计划，就足以第一次写入生产环境。凭据值只在进程内读取，绝不打印，也绝不进入参数、计划、状态文件或报告；golive 保存凭据的文件是仓库之外的明文文件，权限 0600，不是系统钥匙串。有一条边界值得点名：这些 flag 是 agent 代你传的参数，而一个已经登录你服务商的 agent，完全可以在没有任何 golive 计划的情况下直接写入。[信任、访问与控制](docs/TRUST.md)把代码真正强制的东西，和只是要求 agent 遵守的约定，分开了。
- **跑不下去就停，绝不硬推。** `apply` 会在第一处停下：检查没过、确认缺失、前置条件缺失，或者服务商的实际情况与计划矛盾。后续步骤不会执行，下一次 `apply` 从该步骤继续。[恢复](docs/RECOVERY.md#the-run-stopped)讲怎么读失败信息、哪些步骤会续跑，以及哪些情况必须先经过一次有人复核的决定。
- **回滚范围很窄、需要主动开启、而且从不自动发生。** 检查失败永远不会触发回滚。`release.rollback: true` 只会规划一步：把生产指回 golive 自己记录过的更早一次部署；由控制台、Git push 或 pull request 产生的部署不是回滚目标，而且这一步不碰任何数据、DNS、支付或邮件资源。目前只有 Netlify 支持这种重新指向 —— 在 Vercel 上你得去控制台修正生产（Vercel 的适配器读不到生产实际提供的是哪次部署）。晋升（promotion）和回滚已经实现并有 mock 覆盖，但**尚未经过 live 验证**。
- **不会悄悄留下东西 —— 但这不等于什么都没留下。** `golive teardown` 只删除它能证明是自己创建的资源；删除之后会重新读取 DNS zone 和托管项目，并把每一个它删不掉的遗留项 —— Supabase 和 Neon 项目、Resend 发信域名、读不到的 zone 或托管项目 —— 写成一条交接，说明剩下什么、以及怎么手动删掉。删除同时会忘掉 golive 为那个资源记录的基线，这样 `golive status` 就不会把 golive 自己的拆除当成漂移报出来。

完整答案见[信任、访问与控制](docs/TRUST.md)和[恢复](docs/RECOVERY.md)。[架构](docs/ARCHITECTURE.md)是产品契约，[服务商范围](docs/PROVIDERS.md)说明每家服务商今天能做什么，[验证记录](docs/VALIDATION.md)把真正在 live 环境跑过的东西和只有 mock 覆盖的东西分开，[分发](docs/DISTRIBUTION.md)讲安装与更新。

[安装](README.md#install) · [使用 GoLive](README.md#use-golive) · [工作流程](README.md#what-a-run-looks-like) · [Alpha 范围](README.md#what-this-alpha-supports) · [路线图](README.md#the-full-go-live-checklist-and-roadmap) · [参与贡献](CONTRIBUTING.md)

## 安装

你需要 **Node.js 20+**、npm/npx、Git，以及一个能加载 skill 并执行命令的编码 agent。安装流程已在 Codex 和 Claude Code 上检查过；其他客户端尚未验证。

**装一次，所有项目都能用。** 在任意目录下运行：

```bash
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global
```

出现提示时选择你的 agent：方向键移动，空格选中，回车确认。那个界面正在等你的输入；确认之后安装才会继续。

想跳过 agent 选择界面，就用对应 agent 的命令：

```bash
# Codex
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent codex --yes

# Claude Code
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent claude-code --yes
```

如果只想装在单个项目里，就在该项目的仓库目录下运行，并去掉 `--global`。

**或者把下面这段直接粘给你的编码 agent：**

```text
Install the GoLive skill globally so I can use it across projects:
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global

Target the agent I'm using: add --agent codex --yes for Codex, or
--agent claude-code --yes for Claude Code. Keep --global.
If the agent isn't clear, ask me which one.

Verify the installation with:
node <installed-skill-dir>/scripts/golive.mjs version --json
Tell me if I need to reload skills or start a new session.
Stop after installation; don't connect accounts or deploy yet.
```

安装内容包含指令、服务商参考资料和预构建的运行时。它不会连接账号，也不会部署任何东西。非交互式的 agent flag、运行时校验，以及可选的自家安装器，见[安装与更新](docs/DISTRIBUTION.md)。

### 从 npm 安装

同一个 skill 也发布在 npm 上，包名 `golive@0.1.0-alpha.4`（dist-tag 为 `alpha` 和 `latest`），可以离线安装，不需要 Git，也不需要 Skills CLI：

```bash
# Codex
npx golive@alpha install --agent codex

# Claude Code
npx golive@alpha install --agent claude
```

加上 `--global` 会装进你的主目录（`~/.agents/skills/golive` 或 `~/.claude/skills/golive`），而不是当前项目；`--agent claude-code` 这个 Skills CLI 渠道使用的写法同样可以接受。安装器复制的是包里完整的 skill，目标目录已存在时会拒绝安装，并且绝不连接服务商账号。

**两个渠道发布的是同一个版本。** npm 包发布的就是本仓库里的版本，包含独立的安装器辅助脚本，所以从 npm 装出来的是一份自己拥有的副本，可以在原地更新。更早的 `0.1.0-alpha.0` 快照没有更新器：删掉那份重装，或者改用 GitHub 渠道 —— 它会自行管理安装。npm 包同时提供终端 CLI：golive 命令有 `npx golive@alpha help`、`version`、`update-check`、`credentials`、`detect`、`menu`、`init`、`doctor`、`plan`、`teardown`、`apply`、`verify`、`status` 和 `handoff`（`apply` 需要已批准计划的 ID 和显式确认），另有针对它自己拥有的那些副本的安装器命令 `install`、`install-status`、`update`、`rollback`、`update-policy` 和 `recover-lock`。这个渠道的确切限制见[安装与更新](docs/DISTRIBUTION.md#alternative-installation-the-npm-package)。

## 使用 GoLive

在你的编码 agent 里打开应用仓库。安装完成后，如果看不到 GoLive，就重新加载 skill 或开一个新会话。这个 skill 的名字是 **`golive`**。上面那种独立安装，需要**在 agent 的聊天框里**输入下面之一：

| Agent | 示例提示词 |
| --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills#how-chatgpt-and-codex-use-skills) | `$golive Help me take this app live.` |
| [Claude Code](https://code.claude.com/docs/en/skills) | `/golive Help me take this app live.` |

也可以直接用大白话提要求：

```text
Use the golive skill to take this app live. Keep the providers it already uses.
Show me the destination accounts and plan before changing anything.
```

GoLive 会检查这个应用，问清缺少的服务商，并在做出任何服务商改动之前，把目标账号和计划交给你批准。

这些是聊天提示词。`golive skill` 不是命令。通过 `npx skills add` 安装并不会给你的终端添加 `golive` 命令；真正执行的是 agent，它在安装好的 skill 目录里调用附带的 CLI。[npm 包](README.md#install-from-npm)同样可以离线安装这个 skill，并把那个 CLI 以 `npx golive@alpha <command>` 的形式提供；它的终端命令执行的是一个个单独的操作，而不是对话式的 skill 流程。

## 一次运行长什么样

下面是一个示意性的对话，对象是已经在用 Supabase 的应用：

> **你：** 用 golive 把这个应用推上线。先用测试资源。
>
> **Agent：** 这个应用用的是 Supabase。你想托管在哪里？
>
> 1. **Vercel** —— 内置托管流程；和 Supabase 的组合做过 live 测试。
> 2. **Netlify** —— 内置托管流程；做过 live 测试的组合是 Netlify + Neon。
> 3. **其他** —— 告诉我你的服务商；我会用它的官方工具和文档尝试引导式配置。
>
> **你：** Vercel。
>
> **Agent：** 我们保留 Supabase。这个应用已经有 Supabase 项目了，还是要新建一个测试项目？
>
> **你：** 新建一个。
>
> **Agent：** 请在一个单独的终端窗口里运行 `vercel login` 和 `supabase login`。你完成后我会检查连上的是哪个账号和组织。
>
> **你：** 好了。
>
> **Agent：** 计划是这样：在你选定的 Vercel team 里新建一个测试前端项目，在你选定的 Supabase 组织里创建它的数据库，把需要的环境变量传过去，然后部署。我会随计划一起给出实际的目标名称和 ID、资源配置和费用信息。批准之后我才动手。
>
> **你：** 批准。
>
> **Agent：** 部署已经上线。这里是 URL、验证报告，以及所有仍然没验证到的内容。接下来我们测试应用自己的注册和数据流程。这个测试项目用完以后，`golive teardown` 会先规划怎么删除、给你批准，然后才会真的删东西。

GoLive 会保留应用里已有的服务商选择，只追问缺的部分。注册、浏览器登录、身份核验和付款都由你来完成。在 macOS 上如果需要 API key，会弹出一个原生隐藏输入对话框，说明为什么要它、以及 key 会存到哪里；它的值直接写入本地凭据文件，绝不进入聊天内容或命令输出。其他平台退回用你自己的编辑器输入。之后对计划的任何改动都需要重新批准；接入认证或域名，可能需要在首次部署之后再补一次。

**用的是别的服务商？** 这个 skill 有一套通用的引导流程：先看该服务商有没有官方 CLI、可用的官方 MCP 集成或 API，必要时再带你走它的控制台。agent 依然会在请求批准之前给出目标、改动和费用，事后检查它能检查的部分。这属于**尽力而为的引导**，不保证能走完，也不保证达到内置适配器那样的验证覆盖。如果某个步骤做不完或验不了，你会拿到具体的阻塞点和下一步动作。见[引导式服务商范围](docs/PROVIDERS.md#guided-providers)。

## 这个 alpha 支持什么

**托管只有两个选择：Vercel 和 Netlify。数据库只有两个选择：Supabase 和 Neon。**

| 做过 live 测试的路径 | 实际跑过什么 |
| --- | --- |
| **Vercel + Supabase** | 资源开通、环境变量接线、部署、带认证的 CRUD 和访问隔离 |
| **Netlify + Neon** | 资源开通、环境变量接线、部署、Postgres 连通性、双会话 API 检查和浏览器 CRUD |
| **Vercel + Porkbun（自定义域名）** | 绑定域名、在 `--confirm-dns` 下经批准写入一条 DNS 记录、归属验证，以及在一次性子域名上通过 HTTPS 提供服务 |
| **Vercel + GoDaddy（自定义域名）** | 在第二个子域名上走同样的链路，包括绑定之后 Vercel 要求的归属 TXT 验证 |
| **Vercel + Resend（邮件）** | 发信域名配置、DNS 记录、域名验证，以及用应用自己的环境变量 key 真实发送的一次投递（已送达；全新的子域名落进了垃圾箱） |
| **Vercel + Stripe（测试支付）** | 测试模式 key 和 webhook 注册、拒绝未签名的请求，以及一次真实的测试卡支付 —— 以签名验证通过的事件形式送达 |
| **Supabase Auth（SMTP + 密码找回）** | 自定义 SMTP 写入并读回，同时看到被提高的认证邮件速率上限；以及预置测试账号上完整的找回轮换 —— 请求被接受、未知地址得到完全相同的回答、用过的 token 重放时被拒、新密码能登录而旧密码被拒 |

这些都是在你已有账号上经批准的一次性运行；跑完的测试资源随后都被删除，近期几次运行留下的一次性项目和记录也在同样的监督下清理掉了。交叉组合只有 mock 覆盖，没有同等强度的 live 证据。复用 Supabase CLI 登录的方式另外通过了只读验证；而完整的部署测试用的是显式 token。新用户首次开通账号的流程，以及各种应用框架，都还没有验证过。

生命周期命令有自己的证据：`golive teardown` 已在一个一次性 Netlify 项目上实跑过（没有 `--confirm-destroy` 就被拦住，随后完成删除，账号的站点列表除了它以外没有任何变化）；更早的几次运行删掉了 golive 写过的 GoDaddy 和 Porkbun 记录、吊销了它签发的 Resend 发信 key，并移除了它注册的 Stripe 测试模式 endpoint。`golive status` 针对一个线上项目以只读方式运行过；`golive handoff --write` 在一个只涉及 Vercel 的一次性测试夹具（fixture）上运行过：两份产物都写了出来并经过审计（每一行声明都带来源标记，归属证明和拆除闸门都被点名，文档及其 JSON 副本、状态文件和配置里都没有任何形似凭据的值），之后项目通过经批准的拆除流程被移除 —— 那个技术栈只有托管部分，所以文档里其他服务商的行仍然只有 mock 覆盖。证据见[实测验证](docs/VALIDATION.md)。

另外还有一些实验性适配器：Supabase Auth 配置、Supabase Auth 注册链路、它的密码找回和账号隔离，以及 Cloudflare DNS。Supabase Auth 的各项设置 —— 是否允许注册、邮件确认、密码最小长度、它使用的发信方式，加上站点 URL 和重定向允许列表 —— 都通过一个经批准的计划自动写入，再读回作为证据；这条路径已经通过一次一次性 live 运行：策略写入在回读中保持生效（`password minimum length: 6 → 12`），`auth-policy` 最后只剩下内置发信方式这条提示作为唯一发现。可选的注册链路（`auth.e2e`）在同一次运行中通过：一个经批准的步骤预置出一个真实测试账号（`auth:test-user`，需要 `--confirm-live`），该地址在确认之前无法登录（`email_not_confirmed`），`auth-signup`/`auth-session` 两项检查则证明了注册邮件、强制的确认、确认后的登录、会话 token，以及匿名访问被拒。有两条边界依然存在：确认是通过 Auth 管理端 API 完成的，而不是点击预置账号自己收到的那封邮件；收件箱是否真的收到，按设计由人来确认 —— golive 永远看不到收件箱。之后一次在一次性测试夹具上经批准的运行（一个已部署的 Vercel 站点，它声明的路由在没有会话时返回 401，另有一张受 RLS 保护的表）把应用侧的两条腿都跑到了：匿名 GET `auth.protectedPath` 返回 401，登录后的探测程序以已认证用户身份读到了那张表，所以探测程序对 bearer 的修复也不再只有 mock 覆盖。这份证据不能说明的是：那次运行里表的那一行是个计数，而不是表名；并且任何 401 都被算作已保护 —— 一个 WAF 或维护页读起来是一样的。两处之后都修了（issue #30：探测程序现在会列出它读过的表名，受保护路径被拒时会拿公开根路径做交叉核对；有 mock 覆盖，但还没有重跑 live）。密码找回**在同一家服务商上经过 live 验证**：同一次 2026-09-24 的运行同时带着 `auth.smtp: resend`（自定义 SMTP 写入和被提高的认证邮件速率上限，两者都读回验证）和 `auth.recovery: true`；后者唯一那个经批准的步骤（`auth:recovery`，需要 `--confirm-live`）通过服务商自己的找回接口轮换了那个已记录测试账号的密码 —— 请求邮件、用管理端 API 生成链接、用链接换会话、再用会话设新密码 —— 而 `auth-recovery` 检查每一段都通过：请求被接受、不存在的地址得到同样的回答（没有账号枚举）、用过的 token 重放时被拒、新密码能登录而它替换掉的那个不能。点邮件里的链接、以及任何验证码，都仍然要人来做（`auth:recovery-email` 交接里写明了这点）；SMTP 密码是只写的（服务商只返回一个哈希，所以读回能证明的是设置，而不是送达）；账号也是通过 Auth 管理端 API 确认的，而不是账号主人亲手点的。账号隔离同样在这家服务商上实现了：`auth.isolation: true` 配合 `auth.identityPath` 和 `auth.isolationPath` 会加一个经批准的步骤（`auth:isolation`，需要 `--confirm-live`），它预置出**第二个**真实测试账号 —— 地址由 `auth.testEmail` 推导而来，密码同样只存在于那次运行的内存里 —— 并通过服务商的管理端 API 完成确认（不需要点第二封邮件：这条链路关心的是应用的数据，不是送达）。`auth-isolation` 检查随后以两个账号分别登录，在生产 URL 上读取应用自己声明的两条路由：两条都必须拒绝匿名调用（返回 200 就是严重发现）；每个账号在身份路由上都只能拿到自己的 user id，绝不能拿到对方的；数据行路由必须只返回调用者自己的行 —— 验证方式是每个账号各写入一行唯一标记，**通过那条路由**并带上该账号的会话，然后再读回来，所以如果回答里出现另一个账号的标记，那就是跨账号读取，会以严重级别判失败。如果这两条路由没有声明，非阻塞的 `auth:isolation-routes` 交接会把这份应用代码任务交出去；404 或会话被拒会带着这项任务标记为跳过，绝不会算作通过。账号隔离**已实现并有 mock 覆盖，但还没有经过 live 验证** —— 它的 live 运行会另外安排。那次找回运行的输出本身带着两个缺陷，都在这里修好了并补了 mock 回归测试：`teardown` 把账号主人*自己接入*的发信域名报成了 golive 创建的（创建标记列表为空时 `[].every()` 为真，于是每个记录在案的域名都被读成 golive 的）；`auth:recovery-email` 交接把一次单独跑的 `verify` 跳过当成它的证据，而状态文件里那一步明明记录为已完成。它的第三项发现 —— Resend 一直报告该域名已验证，而它列出的记录在 zone 的权威名称服务器上并不存在 —— 由 [#52](https://github.com/mikehasa/golive-skill/issues/52) 修复：`email-verified` 现在会先解析服务商自己为该域名列出的记录，通过与否以此为准（验证通过的域名如果记录没了就判失败；golive 在传播窗口内写入的记录只给警告；服务商列不出记录就跳过而不是通过），邮件计划也会为解析不出来的记录保留 `email:dns` 步骤或交接，所以一个过期的标记再也藏不住它们。有 mock 覆盖；没有重跑 live。上面列的 DNS、邮件和测试模式支付路径都是测过的，自定义域名那几次运行用的是 Porkbun 和 GoDaddy 的记录写入；**Cloudflare DNS 本身还不是这个 alpha 已验证的路径**，其他认证服务商仍然走引导流程。见[服务商范围](docs/PROVIDERS.md)和[实测验证](docs/VALIDATION.md)。

## 完整的上线清单与路线图

一个能打开的 URL 只是开始。视应用而定，上线可能意味着下面这一切。**GoLive 应该判断哪些项适用、帮你把它们做完，并拿出结果证据。** 一个静态站点不该被要求去配数据库；一个收费的 SaaS 也不该停在部署好的首页。

这是我们的产品路线图，同时是一份上线清单。勾选和删除线标记的是**某个具体经过 live 测试的里程碑**，不代表某个类别已经完工，也不代表你的应用可以照单打勾。

**✅ 已通过 live 测试** · **🚧 进行中 / 实验性**（代码已有；完整链路待完成） · **🗺️ 计划中**

### 把应用发布出去

- [x] ✅ **前端托管：** ~~证明能在 Vercel 和 Netlify 上部署。~~ 在两条已测路径上构建、部署并验证目标项目。
- [x] ✅ **数据库：** ~~证明能用 Supabase 和 Neon 开通并连上。~~ 已测路径包含环境变量接线和应用 CRUD 检查。
- [x] ✅ **环境变量接线：** ~~在两条已测路径上把托管和数据库的凭据接起来。~~ 更广泛的密钥轮换和环境生命周期管理仍在计划中。
- [ ] 🗺️ **后端 / 服务器：** 专用 API 服务、容器、常驻服务器、运行时配置和健康检查。应用路由目前已经能通过受支持的托管平台部署。
- [ ] 🗺️ **Schema 与数据：** 经过评审的迁移、安全发布、环境隔离和应用数据检查。这些在 live 测试中是分开监督着做的；可复用的工作流仍在计划中。
- [ ] 🗺️ **文件与对象存储：** bucket、上传、访问规则、签名 URL 和生命周期策略。

### 让它成为一个完整产品

- [ ] 🚧 **认证：** 注册、登录、会话、密码找回和账号隔离。Supabase 的认证策略（是否允许注册、邮件确认、密码最小长度、发信方式）以及站点 URL/重定向允许列表，都通过经批准的计划写入、读回作为证据，并由 `auth-policy`/`auth-redirects` 两项检查验证 —— 在一次经批准的一次性运行中实际跑过，策略写入以十二字符的最小密码长度生效。可选的链路（`auth.e2e: true`）在同一次运行中通过：`auth:test-user` 步骤预置出一个真实测试账号，该地址在确认前无法登录，`auth-signup`/`auth-session` 检查证明了注册邮件、强制的确认、确认后的登录和会话 token —— **在一次性项目上针对 Supabase 经过 live 验证，其中确认是通过 Auth 管理端 API 完成的，而不是点击预置账号收到的邮件；收件箱送达始终由人确认；之后一次运行证明了声明的受保护路径（匿名 401）和以登录身份读取一张受 RLS 保护的表，且报告的是一个计数而不是表名**。密码找回**在同一家服务商上经过 live 验证**（`auth.recovery: true` 会加入 `auth:recovery` 步骤和 `auth-recovery` 检查，后者在一个一次性项目上证明了没有账号枚举、token 只能用一次、以及被替换掉的密码；确认仍通过 Auth 管理端 API，点邮件里的链接仍由人确认；那次运行发现的两个输出缺陷 —— 一条错误的“由 golive 创建”归属声明，和一段与已记录步骤矛盾的交接证据文本 —— 已修复并补了 mock 回归测试）。账号隔离 —— 另一半，也是更早的几次运行没能跑到的那半 —— 也用同样的方式实现并有 mock 覆盖：`auth.isolation: true` 配合 `auth.identityPath` 和 `auth.isolationPath` 会加入 `auth:isolation` 步骤（第二个真实测试账号，通过服务商的管理端 API 确认，并按 id 和地址记录）和 `auth-isolation` 检查，后者以两个账号分别登录，在应用自己的路由上证明双方都读不到对方的身份或数据行（出现跨账号读取会以严重级别判失败；路由未声明或返回 404 则带着应用代码任务跳过）。它的 live 运行同样另行安排。其他认证服务商仍然走引导流程。
- [ ] 🗺️ **OAuth / 社交登录 / SSO：** 客户端注册、授权同意页、scope、回调 URL 和服务商审核。目前的认证服务商配置走引导流程。
- [x] ✅ **支付与订阅：** ~~证明 Stripe 的测试模式结账和 webhook 接收可用。~~ 一次真实的测试卡支付送达了一个签名验证通过的 `checkout.session.completed` 事件。live 模式的就绪程度、权益发放、退款和订阅事件仍需验证。
- [x] ✅ **事务性邮件：** ~~证明 Resend 的发信域名配置、验证和真实送达可用。~~ 通过应用自己的环境变量 key 发出的一封邮件已送达（在全新的子域名上进了垃圾箱，还没有 DMARC）。配置 `auth.smtp: resend` 时，`auth:smtp` 步骤还会写入认证项目的自定义 SMTP —— Resend 的主机/端口/用户名、应用已经在用的发件人，以及一个取自 golive 签发的发信 key 的 SMTP 密码（邮件链路用的那个 key，或者它专门为 SMTP 另发的一个）—— 并在同一次写入里把项目自己的认证邮件速率上限（`rate_limit_email_sent`）提高到每小时 30 封（也可以用 `auth.emailRateLimitPerHour`），因为服务商在启用自定义 SMTP 时仍然保留这道限制。随后 `auth-policy` 会把 `custom SMTP via Resend` 报出来，而不再对内置发信方式给警告。密码是只写的（服务商只返回一个哈希），所以读回能确认的是设置，真正完整的证明只有收到一封真实的认证邮件。**已在一次性项目上经过 live 验证（2026-09-24）**：同一次运行写入了自定义 SMTP 并读回（`smtp.resend.com`、端口 465、用户名 `resend`、发件人 `auth@mail.trytofu.xyz`），同时看到 `auth email rate limit: 2 → 30 per hour`，SMTP key 是它自己签发、又在拆除时吊销的；`auth-policy` 随后读出 `custom SMTP via Resend` 与每小时 30 封认证邮件 —— 只证明设置和速率上限，因为密码本身永远读不回来。退信处理、更丰富的邮件内容和实际的收件箱送达（按设计由人确认，而且在那个域名上很可疑 —— 见 [issue #52](https://github.com/mikehasa/golive-skill/issues/52)）仍需验证。
- [x] ✅ **域名 / DNS / HTTPS：** ~~证明在托管 + DNS 组合上能绑定域名、接通 DNS 并用 HTTPS 提供服务。~~ 已测：Vercel 上绑定域名，配合 Porkbun 和 GoDaddy 在 `--confirm-dns` 下的记录写入、归属验证，以及一次性子域名上的 HTTPS 200。Cloudflare DNS 适配器、重定向和更多托管平台组合仍需 live 验证。
- [ ] 🗺️ **短信与推送通知：** 发送方注册、凭据、权限和送达检查。
- [ ] 🗺️ **第三方与 AI 服务：** API 访问、scope、回调、配额和功能测试。缺失的环境变量今天已经能检测出来；针对具体服务的工作流仍在计划中。
- [ ] 🗺️ **后台任务：** cron 调度、队列、worker、重试和失败任务恢复。
- [ ] 🗺️ **缓存、搜索与实时：** 需要时接入缓存、搜索/向量索引和实时服务。

### 有把握地发布，然后让它持续运行

- [ ] 🗺️ **安全与滥用防护：** 访问策略、泄露的凭据、安全响应头、速率限制和机器人防护。目前已有范围有限的 RLS/advisor 检查和凭据特征检查。
- [ ] 🗺️ **监控与告警：** 错误追踪、日志、可用性和可执行的告警。服务商建议今天走引导流程；经过验证的配置仍在计划中。按需的漂移检查已经有了（下面的 `golive status`）—— 持续监控和告警还没有。
- [ ] 🗺️ **产品分析：** 事件校验和同意/数据设置，比今天引导式的服务商建议更进一步。
- [ ] 🚧 **CI/CD 与安全发布：** 预览、发布检查、晋升、回滚和漂移检测，基于今天这套经批准的 CLI 部署继续建设。**部署身份 —— 已实现，尚未经过 live 验证：** 每次成功部署都会记录服务商为它所做那次部署给出的身份（`.golive/state.json` 中的 `deployed:<target>:id` = `<provider>|<deployment id>|<url>|<time>`，有 mock 覆盖；服务商不上报身份就什么都不记），这样以后的能力就能点名某一次确切的部署。**可选的预览部署与发布检查 —— 已实现，尚未经过 live 验证：** 在 `golive.yaml` 里设置 `release.preview: true`（并在 `targets` 中加上 `preview`）后，`plan` 会加入 `preview:deploy` —— 一个 create 步骤，把当前工作树部署到该托管平台的预览目标，点名服务商、项目、环境目标和预览与生产共用的源项目，当某个 live 模式的值要填进预览环境变量名时需要 `--confirm-live`，并把服务商自己的身份记录为 `deployed:preview:id` —— 以及 `release:check`：它不写任何东西，声明 `preview:deploy` 为自己的前置条件，当服务商读不到那次部署、或对它的构建产物做凭据扫描失败时，整个计划判失败。在构建发布候选版本的那种计划里，这项检查是最后一步，所以它把关的是晋升（晋升自己的计划会在生产改动之前重跑这项检查），而不是同一份计划在它之前已经发出的那次生产部署。**晋升与回滚 —— 已实现，尚未经过 live 验证：** 打开 `release.promote: true`（在预览这一项也开启的基础上）后，计划会以晋升的方式请求一次发布；打开 `release.rollback: true` 后，它会请求把生产重新指向 golive 自己创建并记录过的更早一次部署。`promote:production` 会点名它要推上生产的那次部署的确切 id —— 服务商只有在部署存在之后才会报告它的 id，所以构建候选版本和把候选版本晋升是两份计划，而你批准的那份计划会说明它是哪一份 —— 它由同一个计划里重新读取那次部署的 `release:check` 把关，并且**不需要额外的确认 flag**：计划 id、被点名的部署和刚跑过的这道闸门就是批准。这两个步骤在写入前都会重新读取目标部署和生产当前提供的内容，并在写入后证明生产提供的是什么；两者都保留“跨发布就停”的行为（它们既不是 `replayable`，也不是删除），也都不自动发生 —— 没有任何检查失败会触发回滚，由控制台、Git push 或 pull request 产生的部署永远不是晋升或回滚的目标（它是交接，并且会被明确标注出来）。各家托管平台支持的范围不同，golive 的选择是拒绝而不是猜：Netlify 能重新读取它已发布的部署，也能恢复更早的一次，所以这两个步骤在那里可用；Vercel 不提供生产当前所服务内容的读取，也没有 golive 实际跑过的晋升/回滚调用，所以在 Vercel 上什么都不会被晋升或回滚，只有一条警告说明原因。`production-release` 证明生产提供的是什么、点名它之前提供的是什么，并把 golive 从未记录过的部署报成交接。加入这些步骤 id 会改变计划的 id，所以没被执行的批准必须重新规划。在不提供按部署读取的托管平台（Vercel）上，预览检查（以及因此依赖它的晋升）会跳过，并如实报告，而不是猜。漂移检测以只读的 `golive status` 命令形式存在（见下文）：它在认证验证中只读运行过，等那条链路通过之后就再没有可执行项；但它比较的 DNS、环境变量、webhook 和部署基线仍然缺少 live 证据；预览部署目前也还不在它比较的对象里。
- [ ] 🗺️ **备份与恢复：** 保留策略、恢复演练、事故步骤和经批准的清理。经批准的 `teardown` 会删除 golive 创建的东西；备份和任何恢复仍然是人工、受监督的工作。
- [x] ✅ **卸载 / 拆除：** ~~一份经批准的 golive 创建资源清单，以及它们的删除。~~ `golive teardown` 会规划删除，只删 golive 能证明是自己创建的东西（归属证明加上 `--confirm-destroy`），并在删除后重新读取 DNS zone 中 golive 拥有的记录列表和托管平台自己的项目读取结果。凡是它删不掉的东西都不会被悄悄丢掉：一个遗留项 —— 读不到的 zone、删不掉的托管项目、没登录的服务商 —— 会变成一条交接，写明剩下什么和确切的解决办法，而 Supabase/Neon 项目和 Resend 发信域名仍然需要人工交接（[#9](https://github.com/mikehasa/golive-skill/issues/9)）。删除会忘掉 golive 为那个资源记录的基线，所以 `golive status` 不会把 golive 自己的拆除报成漂移；而 golive 吊销过的发信 key 会报成警告而不是通过，因为服务商没有提供可以确认它的读取方式。
- [ ] 🗺️ **成本与配额：** 套餐选择、预算、告警和容量检查。目前已有范围有限的 Free 套餐守卫；持续的成本管理仍在计划中。
- [ ] 🗺️ **上线必备项：** metadata、分享预览、索引、无障碍、支持链接，以及由账号主人复核过的政策页。
- [ ] 🚧 **归属与交接：** 账号、资源、访问权限、续费责任和维护说明。`golive handoff --write` 会把登录入口、归属证明、周期性任务和删除闸门记录进 `GOLIVE_HANDOVER.md`，并给每一行标注：已验证、已记录、无法验证或未知；`golive status` 则按需重新读取这些对象：它把 golive 记录的基线与服务商现在的实际情况做比较，并点名它读不到的东西。重新建立漂移基线仍然要人工、要批准 —— 这个命令已经实现，并在认证验证中只读运行过，但对每一个漂移对象的 live 验证仍然没有做。

有些步骤永远需要人来完成：接受条款、身份核验、付款、账单选择，以及服务商要求的审核。“引导”仍然应该意味着：明确的下一步动作、正确的页面、正确的权限、事后的检查，以及回到同一条工作流。当应用本身需要改代码时，GoLive 应该给编码 agent 一个具体的任务，并复查结果。它不应该让你去协调十几个互不相干的配置对话。

**接下来：** 把剩下的上线链路做完并做 live 测试 —— 账号隔离的 live 运行（在 Supabase 上已实现并有 mock 覆盖，但还没有在真实项目上跑过）、live 模式的支付流程，以及 Cloudflare DNS 适配器 —— 然后扩展到更多应用架构和持续运维。

这些是方向，不是发布日期。一项能力只有在账号配置、连接、验证和恢复都被实际跑过之后，才应该从实验性毕业。这份清单的任何部分都欢迎贡献，尤其是真实上线卡在哪里的证据。

<details>
<summary>影响了这份路线图的生产环境清单</summary>

这个范围参考了 [Vercel 的上线清单](https://vercel.com/docs/production-checklist)、
[Supabase 的生产环境清单](https://supabase.com/docs/guides/deployment/going-into-prod)、
[Stripe 的上线清单](https://docs.stripe.com/get-started/checklist/go-live)、
[Google 的 OAuth 生产环境指引](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
和 [Next.js 的生产环境指南](https://nextjs.org/docs/pages/guides/production-checklist)。
它们影响了上面的目标；它们既不是 GoLive 的功能，也不是每个应用都必须满足的一揽子要求。

</details>

## 你可以自己检查的验证

报告会记录**通过、失败、警告和跳过**四种结果，以及还剩哪些人工步骤。检查内容包括账号访问、环境变量名、服务商确认的部署 URL、公开 JavaScript 里的密钥特征、数据库访问、受支持的认证/webhook/DNS 设置，以及在托管平台能回答时，服务商声称生产正在提供的那次部署。

部署就绪并不证明应用能用。环境变量名可以存在，但值是错的。邮件域名验证通过也不证明邮件进了收件箱。带签名的支付事件、注册流程和应用自身的业务链路都需要功能测试。**跳过不等于通过。**

你的应用会得到 `golive.yaml`、`.golive/state.json`、`.golive/report.json` 和 `GOLIVE_REPORT.md`。状态文件保存资源 ID 和步骤证据以备恢复；它不是凭据存储。`golive teardown` 在它自己的批准和 `--confirm-destroy` 之后删除 golive 创建的东西；对这些资源不存在跨服务商回滚、恢复或通用的对账命令 —— `release:rollback`（需主动开启）只会把生产重新指向 golive 自己记录过的更早一次部署，不碰任何数据、DNS、支付或邮件资源。

`golive handoff --write` 会加上归属文档：仓库根目录的 `GOLIVE_HANDOVER.md`，以及它在 `.golive/handover.json` 里的 JSON 来源。文档会点名账号和登录入口、golive 创建的每一个资源以及它们的归属证明、哪些仍然是人工的、哪些是周期性的、删除如何运作，以及哪些命令能重新检查每一项。每一行都会说明它是在那次运行中验证过的、更早记录的、golive 无法验证的，还是未知的；golive 不读取账单数据，所以文档里不写费用数字。这些文件里没有密钥值，但不含密钥的元数据仍可能指认出私有资源 —— 分享前先过一遍。除非显式传 `--force`，`--write` 绝不覆盖不是 golive 生成的文件。

`golive status` 问的是下一个问题：在 golive 记录下自己做过什么之后，有没有什么东西在它背后变了？它把记录下来的基线 —— golive 写过的 DNS 记录、它交付的环境变量**名字**、注册的 webhook endpoint、域名绑定、数据库项目及其连接选择项、发信域名、应用 key 背后的支付账号、托管项目 —— 与现在读到的结果做比较，并给两边都打上标签：`expected (recorded by golive <time>)` 对 `observed (read now)`。每一项都会说明谁能处理：重跑一项检查、重新规划并执行一次经批准的改动，或者只有人才能做的决定。它是只读的：不写报告文件、不写任何服务商、不改状态文件；有需要处理的事情时以 `2` 退出。读不到的服务商会被报成无法验证 —— 绝不会报成干净，也绝不会报成失败 —— 它也从不自行重建任何基线。漂移故意不作为闸门：`plan`、`apply` 和 `verify` 从不参考它。`status` 是**已实现**的，并且在 Supabase 认证验证期间只读运行过（一个失败的步骤会浮现出来、被标为需要处理，链路跑通之后列表为空），但对其余漂移对象的 live 验证仍然没有做。

## 凭据与控制权

- **改账号之前先批准。** 计划会点名目标位置和打算做的写入；没有已批准计划的 ID 和 `--yes`，`apply` 会拒绝执行。已安装的发布版本一变，旧的批准就失效。DNS、live 支付和删除步骤有额外的闸门（`--confirm-dns`、`--confirm-live`、`--confirm-destroy`），而一个项目的首次生产部署同样需要 `--confirm-live`，因为过去仅仅批准一个计划，就足以第一次写入生产环境。[信任、访问与控制](docs/TRUST.md#what-golive-may-write-and-what-comes-first)逐条走了一遍每道闸门。
- **别让密钥进聊天。** 受支持的服务商登录会被复用。在 macOS 上，一个原生隐藏输入对话框可以保存需要的 API key；退路是用你自己的编辑器。key 存在 `~/.config/golive/credentials`，这是应用仓库之外的一个本地明文文件，权限 0600 —— 不是操作系统钥匙串，所以任何以你的用户身份运行的程序都能读到它。执行代码不会让凭据值出现在 argv、计划、状态文件、报告和命令输出里，只存指纹而不存值。`golive credentials --remove NAME --yes` 会删除一条已存条目，不可撤销；真正终止访问的是去服务商那里吊销 token。Mac 的登录密码仍然交给 macOS/服务商自己的认证提示；GoLive 从不会要求你在它的 key 对话框里输入登录密码。完整边界见[信任、访问与控制](docs/TRUST.md#the-credential-boundary)。
- **更新有明确的归属。** Skills CLI 管理它自己装的东西。可选的自家安装器支持整包更新和本地回滚；自动替换默认关闭。请在两次部署运行之间更新，绝不要在计划与它的 `apply` 之间更新。云资源不受回滚影响。
- **你的账号始终是你的。** GoLive 不购买服务，也不创建账单账号。你的编码 agent、服务商和安装器各有自己的数据处理方式。

## 参与贡献

🤝 **我们还很早期，非常希望你来一起塑造 GoLive。** bug 报告、功能想法、文档修正和 pull request 都欢迎。贡献不一定要写适配器：一段说不清楚的登录说明、一次真的卡住的上线经历，同样是有用的反馈。

有问题要报或想法要讨论，就开一个 issue；要提 PR，就保持聚焦。如果要加一家较大的服务商或一条新的工作流，建议先开 issue，这样我们可以一起把范围谈定。报告里绝不要包含密钥或原始的认证响应。

本地搭建、测试和你的第一次贡献，见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。[架构](docs/ARCHITECTURE.md)、[信任、访问与控制](docs/TRUST.md)、[恢复](docs/RECOVERY.md)、[服务商范围](docs/PROVIDERS.md)和[验证记录](docs/VALIDATION.md)说明了现在已经有什么、以及哪里需要帮忙。

[MIT 许可](LICENSE)。随包附带的第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
