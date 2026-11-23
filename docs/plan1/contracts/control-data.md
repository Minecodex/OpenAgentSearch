# 管理数据字典与调试样例

公共接口使用 Bearer 项目 Key。管理接口使用服务端会话 Cookie，写操作同时携带 `X-CSRF-Token`。创建资源时由服务分配 UUID，下列示例用保留域名和合成 ID。列表均带可为空的 `next_cursor`。[业务 OpenAPI](business.openapi.yaml) · [管理与健康 OpenAPI](management.openapi.yaml)

## 最小的浏览器项目

项目若使用 Pod 默认网络，直接读取内置能力并将 `browser_proxy_pool_id` 设为 `null` 即可。以下演示绑定代理的分支。管理员先创建代理，再将代理 ID 加入池。下面分别是 `POST /admin/v1/proxies` 和 `POST /admin/v1/proxy-pools` 的示例请求。HTTPS 代理使用 `scheme=https` 并校验证书。

```json
{"name":"检索出口 A","scheme":"socks5","host":"proxy.example.org","port":1080,"auth_mode":"none","max_concurrency":3,"enabled":true}
```

同一列表也接受带认证的 HTTPS 代理。以下凭据仅用于示例，请求中的 `secret` 不参与任何读取视图。

```json
{"name":"检索出口 B","scheme":"https","host":"egress.example.org","port":443,"auth_mode":"password","secret":{"username":"example-user","password":"example-only"},"max_concurrency":2,"enabled":true}
```

取得代理 ID 后即可创建池。池只保存对代理的引用和调度权重。

```json
{"name":"网页访问池","members":[{"proxy_id":"00000000-0000-4000-8000-000000000001","weight":1}]}
```

Firefox Pod 就绪后，系统自动登记内置搜索和正文实例。用 `GET /admin/v1/endpoints` 读取接入点，按 `provider=browser` 识别系统提供的能力，分别选取 `kind=search` 与 `kind=reader` 的 ID。项目使用者绑定稳定的能力 ID，可按需选出口池。新 Pod 就绪和旧 Pod 退出由部署自动同步。[自动注册](../01-system.md#browser-discovery)

管理员通过 `POST /admin/v1/endpoints` 配置外部服务或生成模型。下面以另外添加一个自托管 Crawl4AI 正文服务为例，该步骤仅在项目选用它时才需要。Rust 直接调用实例的原生 API。[支持的组合](endpoint-provider.schema.yaml) · [原生协议](../04-routing-and-providers.md#native-providers)

```json
{"name":"Crawl4AI 读取器","kind":"reader","provider":"crawl4ai","adapter":"http_reader","base_url":"https://crawl.example.org","timeout_ms":8000,"max_concurrency":4,"rpm":60,"options":{"format":"markdown"}}
```

项目请求引用已经存在且类型匹配的接入点。下面示例中，尾号 003、004 分别代表从列表读取的内置搜索和正文 ID，005 为已配置的生成模型，002 为上一步建立的代理池。项目签发 Key 后可使用三个业务操作。

```json
{
  "name":"降水资料库",
  "search_pools":[["00000000-0000-4000-8000-000000000003"]],
  "reader_pools":[["00000000-0000-4000-8000-000000000004"]],
  "model_endpoint_id":"00000000-0000-4000-8000-000000000005",
  "browser_proxy_pool_id":"00000000-0000-4000-8000-000000000002",
  "search_limit":10,"source_limit":4,"body_limit":40000,"summary_limit":1200,
  "rewrite_count":1,"search_original_query":true,"summary_snippets_only":false,"allow_snippets":false
}
```

`search_pools` 与 `reader_pools` 为有序的非空成员组，同种能力下一个端点只能出现一次。可创建只具备部分能力的项目，尝试未配置的操作时返回 `SERVICE_UNAVAILABLE` 并附能力名称。`browser_proxy_pool_id` 为 `null` 时用 Pod 默认网络，绑定后仅经指定代理池。创建返回 `{project,api_key}`。轮换返回 `{api_key,version}`。

## 对象与响应

| 对象 | 主要字段与含义 |
| --- | --- |
| `ProxyView` | `id,name,scheme,host,port,auth_mode,has_secret,max_concurrency,enabled,version,health,active_leases,last_test`。`google_probe` 表示该代理当前版本每 30 分钟进行一次的 curl 检测，含 `reachable,checked_at`。两者均为 `null` 时显示「待首次检测」，该出口暂不承接内置搜索。`last_test` 单独保存手工测试的 `resource_version,status,tested_at,elapsed_ms,reason` 和可用时的 `trace_request_id` |
| `ProxyPoolView` | `id,name,version,members:[{proxy_id,weight}]`。项目绑定池，容量券归实际代理 ID，跨池使用同一代理时不能超配 |
| `EndpointView` | `id,name,kind,provider,adapter,base_url,options,timeout_ms,max_concurrency,rpm,has_secret,version,last_test`。`kind=search/reader/model`。`managed_by` 区分系统内置、Helm 托管和手工资源，`availability` 表示部署可用性。`provider=browser` 表示系统提供的稳定能力，`ready_pods` 为就绪 Pod 数。`browser_search` 另给全体 Pod 共用的一份 `default_network_google_probe`。已完成时其中的 `probe_pod_uid` 标识提供样本的代表 Pod。HTTP 读取的 `options.format` 为 `html/markdown`，搜索时间窗口由适配器及实际浏览器引擎决定，SearXNG 可指定 `engines`。模型声明 `model,tokenizer,max_input_tokens,max_output_tokens 和可选的 context_window_tokens` |
| `ProjectView` | 包含项目请求字段、`id,version`，不会携带业务密钥。各字段生效范围由请求快照确定 |
| `RetentionView` | `GET /admin/v1/settings/retention` 读回 `retention_days,version`。全局唯一配置，所有项目的完整材料、请求及调用明细、聚合统计统一使用，默认 7 天。`PUT` 提交正整数 `retention_days` 与 `expected_version`。成功返回更新后的设置。新天数只影响接下来创建的记录，已有记录保留原到期时间。 |
| `Session` | `username,expires_at,csrf_token`。客户端不能读取会话 Cookie，注销立即使服务端令牌失效 |
| `RequestRecord` | `request_id,project_id,operation,status,started_at,duration_ms,upstream_calls,model_calls,incomplete`。另有 `retention_days,retention_version,expires_at`，均于创建时固定。详情与导出沿用同一截止时刻 |
| `RequestDetail.execution_summary` | 详情首屏和导出共用。包含变体数、去重前后候选数、各评分批次的候选数、答案来源、实际派发的搜索/正文/模型接入点。状态、耗时和上游/模型次数取同一记录的 `metadata`。[字段、空值与计数口径](request-execution.schema.yaml) |
| `Span` | `span_id,parent_id,stage,status,start_offset_ms,duration_ms`。单步详情另含 `input,output,diagnostics`。`replay[]` 以 `material_id` 单独定位一份材料，以 `call_id` 关联实际取得的网页全文及完整模型输入输出。`layout_state` 报告 HTML 布局完整性，原文和模型载荷另用 `state` 表示状态。[回放材料结构](replay-material.schema.yaml) |
| `ReplayLayout` | `GET /admin/v1/requests/{id}/replay/{material_id}/layout` 返回经净化的 `srcdoc`、布局状态、缺失资源数和已知的采集视口。无法定位或无权查看返回 404。请求及布局按创建时固定的时刻一起到期，若仍能核验归属且确认已到期可返回 410。两种响应均不包含历史内容。[布局结构](replay-layout.schema.yaml) |
| `RequestEvidence` | `sources[]` 按来源 ID 列 URL、变体、排名和分数。`segments[]` 保存段 ID、文内起止位置、摘要及是否进入最终引用 |
| `EndpointCall` | `call_id,request_id,endpoint_id,endpoint_version,operation,origin,queue_ms,execution_ms,sent,status,reason`。池内派发可记录 `pool_priority`（从 1 起）；接入点风控或暂时不可用分别记为 `endpoint_failure=risk/unavailable`。浏览器调用的 `browser_job` 给出实际 Pod 的名称、UID、出口模式和阶段耗时。代理模式附池与代理信息。已选择引擎的搜索另给 `google_probe,search_engine`，该调用实际使用百度且首选 Google 时，还保存 `engine_fallback.from/reason/call_id`；其中 `reachable` 必为布尔值，`checked_at` 是检测完成时间。默认网络样本中的 `probe_pod_uid` 指向采样 Pod；`browser_job.pod_uid` 指向实际执行搜索的 Pod。[浏览器作业结构](browser-job.schema.yaml) |
| `Statistics` | `from,to,timezone,overview,series,endpoints`。桶内合并次数、耗时分布与质量分子/分母，展示层据此计算比例。未知比例为 `null` |
| `Aggregates` | `from,to,requests,partial,errors,average_duration_ms,upstream_calls,model_calls`，覆盖整个查询窗口 |

调试 POST 使用与三个公开操作一致的 JSON，响应形状也一致。浏览器任务沿用被调试项目的出口模式，管理台会话不会赋予额外网络权限。导出按请求 ID 重新校验管理员身份，生成脱敏 JSON，可在前端转为 Markdown。

管理调试提交选中项目的业务请求体。综合总结的 `region`、`current_time` 在管理调试中采用相同的可选性与字段错误语义。[业务字段](../02-business-api.md#rewrite-context) · [Atlas 页面和字段](../11-atlas-frontend-reference.md)

模型 options 可选 reasoning_effort，允许 none、minimal、low、medium、high、xhigh、max，须使用具体模型支持的值。省略时不发送该参数。GLM-5.3-Flash 可使用 low、high 或 max，默认 max；短时改写、评分与总结可选择 low。实际模型调用与回放保留该选项。[模型参数](https://help.aliyun.com/en/model-studio/glm-zhipu)

项目字段 summary_snippets_only 默认 false。为 true 时，综合总结只依据搜索列表的标题和简介，保留评分、模型上下文规划和引用，跳过正文池调用与随附正文。可仅配置搜索池和模型，reader_pools 可为空。关闭后恢复正文获取。allow_snippets 继续表示正文失败后的简介回退，列表总结模式中无需开启它。缺省字段按 false 解读，历史请求快照保留原值。
