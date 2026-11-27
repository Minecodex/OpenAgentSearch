# OpenAgentSearch 设计文档

OpenAgentSearch 提供三个同步业务接口。调用方可以搜索网页列表，可以传入一个 URL 同时取得 Markdown 和纯文本正文，也可以提交问题，由服务搜索、评分、生成分段摘要，最后返回带来源的整体总结。综合总结接受调用方自选的地区和带偏移时间，用于解释问题中的相对地点和日期。

这套文档定义首版的产品行为、架构和验收条件。后端使用 Rust。管理台使用 React、TypeScript 和 HeroUI，支持中英文、浅色与深色。项目可选择稳定的内置 Firefox 搜索与正文能力。绑定 VPN 代理池时使用该池的 SOCKS5/HTTPS 出口，未绑定时使用 Pod 默认网络。内置搜索按所选出口的 Google 连通结果决定引擎。后台每 30 分钟用 curl 检测每条启用的 VPN 和一份所有 Firefox Pod 共用的默认网络。出口完成首次检测后才参与内置搜索。

在已有 Kubernetes 集群上使用 Helm 和 `oasctl` 安装、升级、查询状态和诊断。基础安装包含前端、后端、PostgreSQL 和 Firefox 执行器；就绪 Pod 自动加入，项目引用保持稳定。SearXNG 搜索服务与 Crawl4AI 正文服务均为可选组件，可在安装或升级时分别启用。[Helm 组件配置](plan1/01-system.md#helm-components)

运行历史采用全局统一保留期，默认 7 天。修改后，所有项目的新请求、完整材料、明细及其统计贡献统一采用新天数，已有记录按原定时间到期。请求详情可在隔离 iframe 中回放归档网页的原布局，并渲染 Markdown 材料。[历史保留与回放](plan1/06-observability.md#layout-replay)

## Plan 2 搜索缓存

Plan 2 用统一 embedding 与 Qdrant 复用历史问题，保存各来源已经取得的原始列表和完整正文。额外补文只针对本次实际返回的 Top K 或综合选用的 Top N，未入选原始候选保留已有材料，定时列表刷新不预取整榜正文。本期采用可配置的固定列表/正文 TTL，AI 页面分类及不同类型的 TTL 留作后续扩展。两个高置信问题命中继续按既有规则执行。[数量与按需补文](plan2/README.md#counts) · [当前固定 TTL](plan2/README.md#cache-ttl) · [双热点](plan2/01-hotness.md) · [缓存管理](plan2/03-cache-console.md)

缓存模块通过稳定入口装配唯一活动的 Handler，切换直接采用新缓存空间，旧版本任务不执行且不复活。后台每轮派发使用最新配置，任务和存储读写共用一致性执行层。[Handler 架构](plan2/04-cache-architecture.md)

各项目在创建/编辑界面通过“启用搜索缓存”开关单独控制，默认关闭。关闭时直接按项目路由处理，停止本项目缓存读写、按需补齐和热点刷新，已有材料保留到正常过期或回收。[项目开关及界面](plan2/README.md#project-cache-switch)

部署配置、集群覆盖示例、缓存参数与自动化验证见 [缓存配置与验证](plan2/05-runtime.md)。

## 从哪里开始

| 要实现的部分 | 设计入口 |
| --- | --- |
| 系统拓扑、执行边界、进程生命周期 | [01 系统架构](plan1/01-system.md) |
| 三个业务 API 的请求、响应、错误和示例 | [02 业务 HTTP 契约](plan1/02-business-api.md) · [OpenAPI 3.1](plan1/contracts/business.openapi.yaml) |
| 查询、选材、网页转 Markdown/纯文本、打分与分段总结 | [03 搜索与内容流水线](plan1/03-search-pipeline.md) |
| 搜索、正文、模型接入点的能力、路由、重试与限额 | [04 调度与适配器](plan1/04-routing-and-providers.md) |
| 配置项目、签发密钥、持久化、管理 API | [05 控制面与数据模型](plan1/05-control-and-storage.md) · [管理数据字典](plan1/contracts/control-data.md) · [管理与健康 OpenAPI](plan1/contracts/management.openapi.yaml) |
| 请求记录、材料与引用、调用明细和指标 | [06 请求记录与观测](plan1/06-observability.md) |
| VPN 代理列表、SOCKS5/HTTPS、浏览器分配与回收 | [07 浏览器与代理池](plan1/07-browser-proxies.md) |
| HeroUI 组件、页面交互、主题与国际化 | [08 管理台设计](plan1/08-console.md) · [Atlas 工作台](plan1/demo.html) · [页面与接口对照](plan1/11-atlas-frontend-reference.md) |
| Rust 从零实现的顺序、Docker 本地环境与验收矩阵 | [09 实施与验收](plan1/09-rust-and-acceptance.md) |
| 已采用的设计选择、理由和变更影响 | [10 设计决策](plan1/10-design-decisions.md) |
| `oasctl` 的安装、升级、诊断、持久化和失败恢复 | [12 安装与运维](plan1/12-oasctl-and-helm.md) |

## 按流程找图

| 场景 | 对应流程图 |
| --- | --- |
| 启动服务，处理第一次业务请求 | [部署与生命周期](plan1/01-system.md#topology) · [入口与终态](plan1/02-business-api.md#entry) |
| 返回有序列表，或从单一 URL 生成双格式正文 | [列表检索](plan1/03-search-pipeline.md#list) · [正文提取](plan1/03-search-pipeline.md#read) |
| 改写查询、合并候选、打分、分段、归并与引用 | [选材](plan1/03-search-pipeline.md#selection) · [分段与整体总结](plan1/03-search-pipeline.md#synthesis) |
| 限流、选接入点、处理失败和取消 | [接入点选路](plan1/04-routing-and-providers.md#routing) · [资源调度](plan1/04-routing-and-providers.md#resources) |
| 登录、保存配置、轮换项目 Key、检查引用 | [管理操作](plan1/05-control-and-storage.md#mutation) · [实体关系](plan1/05-control-and-storage.md#data) |
| 追溯答案来源，计算接入点统计 | [材料与引用](plan1/06-observability.md#evidence) · [记录与统计](plan1/06-observability.md#observe) |
| 管理代理，分配出口和浏览器，回收异常任务 | [代理配置](plan1/07-browser-proxies.md#registry) · [分配与回收](plan1/07-browser-proxies.md#dispatch) |
| 从管理台发起调试或完成本地验收 | [管理台操作](plan1/08-console.md#journey) · [实施路径](plan1/09-rust-and-acceptance.md#delivery) |

流程图以 Mermaid 编写。改变产品行为时，同时更新相应章节、契约与验收场景。
