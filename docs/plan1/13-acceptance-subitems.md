# 13 验收子项与证据门禁

本清单细化 [A01–A27 验收矩阵](./09-rust-and-acceptance.md#验收矩阵)。每行都是必须完成的行为，机器清单为 `tests/acceptance/subitems.json`，两份内容应同步维护。Rust 单元测试、真实 PostgreSQL 仓储测试、Docker HTTP/Firefox/HeroUI E2E 和 Kubernetes Helm 验收分层执行；标为多层的子项必须在每个指定层次均有成功断言。

`check` / `prove` 只在真正执行断言后登记结果，记录子项 ID、断言数量、源码位置、执行 ID、套件及源码 SHA-256。运行器对源码、依赖锁、契约、配置、测试和设计文档计算指纹，测试镜像携带同一标签。完整 Docker 与 Kubernetes 运行结束后才能生成完成元数据。报告校验当前源码、两套运行、镜像标签和每条断言的一致性，拒绝缺项、失败、零断言、路径越界、无源码位置、部分运行和旧版汇总结果。测试名称只用于统计用例数，不作为完成证据。门禁的负向测试在 `tests/acceptance/gate.test.mjs`。

报告和逐断言 JSONL 仅保存于忽略提交的 `artifacts/`，本清单描述长期验收要求，不记录某一次部署或运行结果。受控搜索页、原生协议及确定性模型夹具验证协议和证据约束；真实 SearXNG、Crawl4AI、Firefox、PostgreSQL、Kubernetes 和 Helm 验证本地服务集成。

| 子项 ID | 必须验证的行为 | 必需执行层次 |
| --- | --- | --- |
| A01.auth.content.en | 正文接口无效 Key 返回英文错误 | docker |
| A01.auth.content.zh | 正文接口无效 Key 返回中文错误 | docker |
| A01.auth.list.en | 列表接口无效 Key 返回英文错误 | docker |
| A01.auth.list.zh | 列表接口无效 Key 返回中文错误 | docker |
| A01.auth.summary.en | 总结接口无效 Key 返回英文错误 | docker |
| A01.auth.summary.zh | 总结接口无效 Key 返回中文错误 | docker |
| A01.blank | 空白问题返回字段错误 | docker |
| A01.duplicate.content | 正文拒绝重复 JSON 键 | docker |
| A01.duplicate.list | 列表拒绝重复 JSON 键 | docker |
| A01.duplicate.summary | 总结拒绝重复 JSON 键 | docker |
| A01.integer | 整数字段拒绝小数表示 | docker |
| A01.large.content | 正文在 JSON 解析前拒绝超量请求体 | docker |
| A01.large.list | 列表在 JSON 解析前拒绝超量请求体 | docker |
| A01.large.summary | 总结在 JSON 解析前拒绝超量请求体 | docker |
| A01.only_three | 公开业务 OpenAPI 恰好三个操作 | docker |
| A01.unknown.content | 正文拒绝未知字段 | docker |
| A01.unknown.list | 列表拒绝未知字段 | docker |
| A01.unknown.summary | 总结拒绝未知字段 | docker |
| A02.admin_password_reset | 显式重置使旧密码及旧会话失效，已校验旧散列的并发登录也不能补发会话 | database, docker |
| A02.concurrent_write | 同版本并发修改恰好一次成功、一次冲突 | docker |
| A02.immutable_snapshot | 在途请求继续使用冻结配置 | docker |
| A02.rotate_key | 轮换后仅新 Key 可鉴权 | docker |
| A03.dedup | 规范 URL 稳定去重 | docker |
| A03.legal_empty | 合法零命中返回 empty | docker |
| A03.malformed | 畸形响应返回上游错误 | docker |
| A03.missing_title | 缺失标题不伪造字段 | docker |
| A03.no_model | 列表流程没有模型调用 | docker |
| A03.partial | 无效候选与有效候选并存时返回 partial | docker |
| A03.upstream_error | 上游失败不冒充合法空结果 | docker |
| A04.confirmed_final | 只有上游确认时另填最终 URL | docker |
| A04.dual_formats | 同页同时返回 Markdown 和纯文本 | docker |
| A04.lengths | 长度使用 Unicode 标量计数 | docker |
| A04.no_search_model | 正文流程不检索、不调用模型 | docker |
| A04.one_url | 只传一个 URL 即可取文 | docker |
| A04.unicode | 保留多字节字符与语义格式 | docker |
| A05.empty_article | 空正文返回失败 | docker |
| A05.login | 登录页不返回空成功 | docker |
| A05.minimum_limit | 过小正文限额给出稳定字段错误 | docker |
| A05.redirect_private | 重定向到禁止目标也拒绝 | docker |
| A05.redirect_public | 公网允许目标重定向后保留请求地址 | docker |
| A05.truncation | 双格式截断遵循同一文档树及限额 | docker |
| A05.unreachable | 无法取到页面不返回空成功 | docker |
| A05.unsafe_input | 拒绝私网和不允许的输入 URL | docker |
| A06.all_irrelevant | 全部明确不相关返回合法空结果 | docker |
| A06.correction_once | 只纠正一次且只补缺失候选 | docker |
| A06.invalid_ids | 未知和重复评分 ID 不污染候选 | docker |
| A06.stable_ties | 同分按冻结顺序稳定排序 | docker |
| A06.variant_merge | 多变体重复命中仅生成一个候选 | docker |
| A07.compression_bound | 来源压缩最多两轮且保留引用 | docker |
| A07.exact_tokens | 完整提示词在准确 Token 边界检查 | rust |
| A07.format_retry_once | 模型格式纠正最多一次 | docker |
| A07.invalid_citation | 不存在的引用不能进入成功综合 | docker |
| A07.long_passages | 长正文按序形成多段 | docker |
| A07.partial_passages | 单段失败仍保留有效证据并返回 partial | docker |
| A07.segment_cap | 每来源至多十六段 | docker |
| A07.short_passage | 短正文只生成一段 | docker |
| A07.stable_order | 并行完成不改变段序 | docker |
| A08.cancel_release | 排队取消及时归还准入 | rust |
| A08.completed_cancel | 取消时保留先完成分支的结构化命中 | rust, docker |
| A08.completed_timeout | 超时时保留先完成分支的结构化命中 | rust, docker |
| A08.cpu_lifetime | 已启动 CPU 工作退出后才归还名额 | rust |
| A08.global_queue_full | 全局等待队列满后拒绝新增等待 | rust |
| A08.model_fairness | 模型队列在请求之间轮转 | rust |
| A08.parallel_limit | 单请求模型并行上限可核对 | rust |
| A08.synthesis_reserve | 取文与段摘要为最终综合预留预算 | rust |
| A08.total_deadline | 慢上游不重置全局截止时间 | rust |
| A08.unsent_rpm | 未实际发送的预留不消耗 RPM | rust |
| A09.auth_failure | 代理认证失败可区分 | rust, docker |
| A09.body_mismatch | 正文标记不匹配有独立归因 | rust, docker |
| A09.disabled | 停用代理立即退出新派发 | docker |
| A09.expected_200 | 预期状态及正文均匹配才成功 | rust, docker |
| A09.https | HTTPS CONNECT 配置正确保存 | docker |
| A09.no_secret_echo | 资源和测试回执不回显口令 | docker |
| A09.password | 带口令代理可完成手工测试 | docker |
| A09.phase_diagnostics | 连接、协议及目标响应阶段分开计时 | rust, docker |
| A09.reference_conflict | 仍被池引用时删除返回可定位冲突 | docker |
| A09.socks | SOCKS5 配置正确保存 | docker |
| A09.tls_failure | 代理证书失败可区分 | rust, docker |
| A09.unexpected_404 | 目标 404 判测试失败但通道可达 | rust, docker |
| A09.unexpected_500 | 目标 500 判测试失败但通道可达 | rust, docker |
| A09.version_receipt | 测试回执固定被测版本且改版不继承 | docker |
| A10.atomic_lease | 浏览器及代理资源原子授予无半占用 | rust, docker |
| A10.both_saturated | 两条健康出口均满后拒绝额外租约 | rust, docker |
| A10.fixed_egress | 同作业的 Pod、上下文与出口固定，查询及网页使用独立作业 | docker |
| A10.https_egress | 实际页面流量经过选中的 HTTPS 出口 | docker |
| A10.one_reselection | 可归因代理连接失败最多重选一次 | docker |
| A10.shared_proxy_limit | 不同项目共享代理实际并发上限 | rust, docker |
| A10.socks_egress | 实际页面流量经过选中的 SOCKS5 出口 | docker |
| A10.target_refusal | 站点拒绝不降低健康代理状态 | docker |
| A10.tie_rotation | 相同权重轮转无永久偏置 | rust |
| A10.weighted_choice | 两个健康出口按池权重选择 | rust, docker |
| A11.bounded_registry | 注册表有容量上限并拒绝溢出 | rust |
| A11.cancel_navigation | 导航中取消终止访问并回收 | docker |
| A11.deadline_cancel | 执行器截止不被扩展命令门控阻塞 | rust |
| A11.late_open | 取消后迟到 open 不能重开作业 | rust, docker |
| A11.quarantine | 未确认清理的名额隔离至回执 | rust, docker |
| A11.stale_owner | 旧 owner 不能关闭新作业 | rust, docker |
| A11.target_denial | 站点明确拒访后停止该访问 | docker |
| A11.worker_crash | 执行器崩溃返回失败并恢复 | docker |
| A12.distinct_ids | 不同项目相同问题拥有不同请求 ID | docker |
| A12.project_calls | 调用归属各自项目 | docker |
| A12.scoped_citations | 来源引用属于此次请求 | docker |
| A12.snapshot_version | 记录固定执行时项目版本 | docker |
| A13.calendar_timezone | 日历桶按查询时区解释 | docker |
| A13.completed_evidence | 完成和未完成变体分别记录已知下界 | rust, docker |
| A13.conflict_rollback | 同 call_id 冲突载荷使整个事务回滚 | database |
| A13.day_and_edges | 整日及两端零散窗口正确组合 | docker |
| A13.drop_counter | 观测丢弃计数及原因可核对 | docker |
| A13.expired_payload | 载荷过期不伪装为完整材料 | docker |
| A13.idempotent_call | 重复 call_id 只入库及累计一次 | database |
| A13.no_double_count | 小时与日贡献不重复累计 | docker |
| A13.phase_accounting | 慢上下文不计入导航或执行子阶段 | rust |
| A13.queue_business_independent | 观测队列阻塞不改变业务终态 | docker |
| A13.unknown_ratio | 分母为零的比率为未知 | docker |
| A14.atlas_controls | Atlas 分组导航、卡片内边距、35px 常规操作、28px 紧凑操作与表单尺寸一致 | docker |
| A14.blue_theme | 中英文桌面和窄屏的主操作使用 #5070f2，卡片与趋势图适配浅色及深色主题 | docker |
| A14.citation_range | 引用下钻高亮对应原文范围 | docker |
| A14.display.en.dark | 英文深色页面可用 | docker |
| A14.display.en.light | 英文浅色页面可用 | docker |
| A14.display.zh.dark | 中文深色页面可用 | docker |
| A14.display.zh.light | 中文浅色页面可用 | docker |
| A14.focus_restore | 独立放弃确认恢复到安全焦点 | docker |
| A14.form_control_rows | 调试项目在输入卡片内，搜索只显示整框焦点，字段与同行操作等高 | docker |
| A14.keyboard | 键盘可切换页签 | docker |
| A14.login | 真实浏览器完成管理员登录 | docker |
| A14.login_split | 登录页桌面左右分栏、窄屏上下排列，OpenAgentSearch 说明与登录表单独立，中英文深浅色均可用 | docker |
| A14.markdown_plaintext | 正文 Markdown 与纯文本视图可切换 | docker |
| A14.narrow | 窄屏不发生页面横向溢出 | docker |
| A14.no_refetch | 历史切换视图不重抓原站 | docker |
| A14.pool_create | 通过 HeroUI 创建带权重代理池 | docker |
| A14.project_create | 通过 HeroUI 创建项目及一次性密钥 | docker |
| A14.three_operations | 调试台三项业务操作可执行 | docker |
| A15.citation_quality | 核对引用有效率 | docker |
| A15.default_admin | 未配置初始账号时使用 admin / admin123，并能通过真实登录 | docker |
| A15.empty_database | 空 PostgreSQL 启动后迁移、初始管理员及内置能力就绪 | docker |
| A15.error_rate | 记录独立失败率 | docker |
| A15.fact_language_time | 事实、目标语言及无虚构日期符合基线 | docker |
| A15.latency | 记录 P50 与 P95 | docker |
| A15.material_coverage | 核对材料覆盖率 | docker |
| A15.mixed_load | 混合三操作及双语并发负载可复现 | docker |
| A15.model_replacement | 替换模型标识后重新执行同一基线 | docker |
| A15.ownership_loss | 丢失调度所有权取消在途工作且重启恢复 | docker |
| A15.queue_time | 记录上游累计排队时间 | docker |
| A15.token_usage | 记录输入及输出 Token | docker |
| A16.available_options | 新增成员只预选可用组件 | docker |
| A16.combination.00 | 两项关闭时基础服务就绪且无可选工作负载和服务 | kubernetes |
| A16.combination.01 | 仅取文组件启用时资源与开关一致 | kubernetes |
| A16.combination.10 | 仅搜索组件启用时资源与开关一致 | kubernetes |
| A16.combination.11 | 两项启用时资源与开关一致 | kubernetes |
| A16.combined_pipeline | SearXNG 到 Crawl4AI 组合进入总结 | kubernetes |
| A16.crawl4ai_dns | 公开域名解析可按需仅在 Crawl4AI Pod 内启用经过身份校验的 DNS over TLS，集群域名仍由集群 DNS 解析 | kubernetes |
| A16.disabled_reference | 升级关闭后保留项目引用并显示不可用 | docker, kubernetes |
| A16.independent_switches | 两个组件的 Deployment 和 Service 独立受控 | kubernetes |
| A16.native_reader | 真实 Crawl4AI 原生取文返回正文 | kubernetes |
| A16.native_search | 真实 SearXNG 原生搜索返回结果 | kubernetes |
| A17.context.both | 两项同时存在时独立呈现 | docker |
| A17.context.none | 无附加上下文时不生成相关指令 | docker |
| A17.context.region | 仅地区时独立生成地区字段与指令 | docker |
| A17.context.time | 仅时间时独立生成时间字段与指令 | docker |
| A17.invalid_date | 非法日历日期指出字段 | docker |
| A17.midnight_offset | 跨午夜等价时刻保留各自当地日期 | docker |
| A17.offset_required | 时间缺少偏移被拒绝 | docker |
| A17.rewrite_disabled | 零次改写不产生模型改写调用 | docker |
| A18.catalog.model | 模型分类按目录新增服务商 | docker |
| A18.catalog.reader | 正文分类按目录新增原生服务商 | docker |
| A18.catalog.search | 搜索分类按目录新增原生服务商 | docker |
| A18.committed_debug | 调试使用已提交项目配置 | docker |
| A18.conflict_draft | 版本冲突保留草稿并允许载入最新 | docker |
| A18.credential_actions | 保留、替换、清除凭据含义一致 | docker |
| A18.fractional_timeout | 秒的小数精确转换为毫秒 | docker |
| A18.historical_version | 修改配置后历史仍显示原快照 | docker |
| A18.language_catalog | 通过中英文名称或标签从地区语言目录选择并保存优先路由 | docker |
| A18.pool_order | 界面调换池后保存并影响下一次调用 | docker |
| A18.save_language_route | 语言优先规则可保存并读取 | docker |
| A18.test_version | 测试固定执行版本不覆盖新版回执 | docker |
| A19.citation_scope | 来源及引用在请求内有效 | docker |
| A19.incomplete_payload | 取消或载荷不完整不显示成零命中 | rust |
| A19.inline_article | 搜索随附正文可直接成为材料 | docker |
| A19.missing_material | 无材料明确显示缺失 | docker |
| A19.reader_article | 独立取文成功可成为材料 | docker |
| A19.reader_failed_chain | 全部取文失败后简介保留全部尝试 | docker |
| A19.reader_retry_chain | 首个取文失败到后续成功保留全部关联 | docker |
| A19.snippet_fallback | 普通取文失败后按项目设置回退简介 | docker |
| A19.unicode_ranges | 多字节字符原文范围可复核 | docker |
| A19.unsafe_no_snippet | 拒绝访问目标不通过简介继续处理 | docker |
| A20.atlas_dashboard | 总览使用深蓝趋势及操作分布，按真实数据和时段下钻，缺省零值不显示 NaN | docker |
| A20.defaults_explicit | 调试默认继承与显式覆盖可区分 | docker |
| A20.discard_dialog | 未保存表单使用独立确认弹框 | docker |
| A20.endpoint_detail | 各类接入点只读详情显示协议与单位 | docker |
| A20.field_errors | 失败提示指出具体字段 | docker |
| A20.overlay_widths | 编辑、普通、确认和侧抽屉按实际可视宽度展开，长表单滚动时页脚可操作 | docker |
| A20.pool_detail | 池只读详情显示成员名称和权重 | docker |
| A20.project_detail | 项目只读详情显示资源名称及取值 | docker |
| A20.project_layout | 项目卡片按可用宽度最多四列，表单的两类接入点池各占一行 | docker |
| A20.proxy_detail | 代理只读详情显示主机、端口及编辑入口 | docker |
| A20.readable_browser_phases | 浏览器阶段以双语名称、层级和毫秒呈现 | docker |
| A20.reference_links | 资源引用跳转到对应详情 | docker |
| A20.return_filters | 调用下钻返回保留查询条件 | docker |
| A20.route_draft | 语言路由草稿跨页面保留 | docker |
| A20.separate_edit | 详情与编辑分离 | docker |
| A21.browser_reader_exempt | 内置正文不受半小时排除但能降级 | docker |
| A21.browser_search_exempt | 内置搜索不受半小时排除但能降级 | docker |
| A21.cross_project_risk | 普通接入点风控跨项目共享 | docker |
| A21.equal_round_robin | 同池接入点等权轮询 | docker |
| A21.forward_only | 从入口只向后尝试不回绕 | docker |
| A21.language_entry | 语言命中池立即作为入口 | docker |
| A21.native_time_capabilities | 显式日期按适配器原生能力过滤，仅剩不支持成员时不发上游请求 | docker |
| A21.observation_readonly | 只改变观测样本不改变调度 | docker |
| A21.open_languages | 请求语言只选起始池，语言标签归一化，未传语言从第一池开始 | docker |
| A21.pool_exhausted | 整个池无法调用才向后降级 | docker |
| A21.recover_30m | 普通风控恰在三十分钟到期恢复 | rust |
| A21.risk_one_peer | 单个成员风控仍可用同池其他成员 | rust |
| A22.historical_pod | 历史记录保留替换前实际 UID | kubernetes |
| A22.new_capacity | 已有项目自动使用第三份容量 | kubernetes |
| A22.ready_only | 仅就绪 Pod 承接 | kubernetes |
| A22.restore | 恢复副本后自动恢复承接 | kubernetes |
| A22.rolling_replace | 滚动替换后新调用使用新 UID | kubernetes |
| A22.scale_2_to_3 | Firefox 从两 Pod 扩至三 Pod 自动发现 | kubernetes |
| A22.zero_preserves_refs | 缩至零保留能力引用并拒绝新浏览器调用 | kubernetes |
| A23.both_engines_fail | 两个引擎都被拒绝后按项目池规则尝试下一接入点 | docker |
| A23.default_shared | 多个执行 Pod 引用共享默认样本 | rust |
| A23.engine.default.baidu | 默认网络不可达选择百度 | docker |
| A23.engine.default.google | 默认网络可达选择 Google | docker |
| A23.engine.proxy.baidu | 代理不可达选择百度 | docker |
| A23.engine.proxy.google | 代理可达选择 Google | docker |
| A23.frozen_sample | 已开始作业固定样本、后续作业用新样本 | docker |
| A23.google_empty_terminal | Google 明确返回空结果时只记录一次调用 | docker |
| A23.google_timeout_fallback | Google 搜索超时时给同一请求保留百度尝试预算 | docker |
| A23.measured_peer | 同池已测成员可承接 | rust |
| A23.probe_cardinality | 每轮两 VPN 加默认网络恰好三次检测 | rust |
| A23.reader_independent | 正文不依赖 Google 探测结果 | docker |
| A23.representative_handoff | 代表 Pod 替换不重复常规周期 | rust |
| A23.restart_schedule | 恢复及周期边界不触发额外检测 | rust |
| A23.runtime_google_fallback | 业务搜索切换到百度时复用 Pod 与代理、保留问题及时间范围，并关联两次调用 | docker |
| A23.scale_to_6 | 扩至六 Pod 不增加检测数量 | rust |
| A23.stale_version | 旧配置版本回执不能发布样本 | rust |
| A23.test_engine_fallback | 内置搜索测试在 Google 风控时同作业尝试百度并返回实测结果 | docker |
| A23.unknown_no_lease | 未首测出口获得零搜索租约 | rust |
| A24.inline_scoring | 随附正文能进入评分且无需再次取文 | docker |
| A24.no_firefox | 原生适配占用零 Firefox 槽位 | docker |
| A24.reader.anysearch | AnySearch 正文原生路径、鉴权、成功、空、HTTP及业务失败 | docker |
| A24.reader.crawl4ai | Crawl4AI 正文原生路径、鉴权、成功、空、HTTP及业务失败 | docker |
| A24.reader.deepseek | DeepSeek 正文原生路径、鉴权、成功、空、HTTP及业务失败 | docker |
| A24.reader.tavily | Tavily 正文原生路径、鉴权、成功、空、HTTP及业务失败 | docker |
| A24.search.anysearch | AnySearch 搜索原生路径、鉴权、成功、空、HTTP及业务失败 | docker |
| A24.search.deepseek | DeepSeek 搜索原生路径、鉴权、成功、空、HTTP及业务失败 | docker |
| A24.search.searxng | SearXNG 搜索原生路径、鉴权、成功、空、HTTP及业务失败 | docker |
| A24.search.tavily | Tavily 搜索原生路径、鉴权、成功、空、HTTP及业务失败 | docker |
| A24.unknown_final_url | 上游未确认最终地址则保留请求 URL 并省略 final_url | docker |
| A25.command_timeout | 命令超时指出等待阶段 | kubernetes |
| A25.doctor_components | doctor 核对可选原生组件与 schema | kubernetes |
| A25.doctor_service_account | doctor 核对实际 ServiceAccount 权限 | kubernetes |
| A25.doctor_storage | doctor 核对 PVC、卷归属及存储类 | kubernetes |
| A25.initial_admin_options | oasctl 安装参数覆盖 values 中的初始账号密码，口令文件不进入 Helm 参数 | rust, kubernetes |
| A25.install | oasctl 从空命名空间安装就绪 | kubernetes |
| A25.migration_failure | 迁移失败指出阶段与迁移实况 | kubernetes |
| A25.preserve_admin_credentials | 重启和升级保留已有管理员，不重新套用初始化密码 | database, kubernetes |
| A25.preserve_config | 升级保持项目配置 | kubernetes |
| A25.preserve_history | 升级后原请求仍可读取 | kubernetes |
| A25.preserve_key | 升级后原业务 Key 仍有效 | kubernetes |
| A25.preserve_secret | 升级保持加密接入点凭据且仍可调用 | kubernetes |
| A25.retry_inspection | 重试后可核对修订、迁移及已部署状态 | kubernetes |
| A26.archived_layout_assets | 保存两栏布局、样式、图片及字体 | docker |
| A26.markdown_render | Markdown 渲染标题、表格及代码 | docker |
| A26.model_exchange | 模型归档保存实际原始消息与回复 | docker |
| A26.no_scripts | 回放无脚本或外部执行 | docker |
| A26.offline | 原站下线后仍可回放 | docker |
| A26.partial_assets | 布局资源缺失明确标部分并保留正文 | docker |
| A26.sandbox | iframe 使用空 sandbox | docker |
| A26.source_view | 可查看 Markdown 源文 | docker |
| A26.wrong_request | 不能跨请求读取材料 | docker |
| A27.calls_expire | 到期调用停止展示 | docker |
| A27.export_expire | 到期记录不可导出 | docker |
| A27.extend_new_only | 延长期限也只作用于新记录 | docker |
| A27.fixed_expiry | 每条记录固定创建时的到期时刻 | docker |
| A27.four_day_old_visible | 已保存四天的旧记录仍可读 | docker |
| A27.materials_expire | 到期材料和回放不可读 | docker |
| A27.mixed_same_version | 同版本不同到期时刻也正确过滤 | docker |
| A27.mixed_versions | 同小时桶跨设置版本按贡献期限过滤 | docker |
| A27.new_only | 新设置仅影响之后产生的数据 | docker |
| A27.physical_cleanup_lag | 物理回收滞后不暴露过期数据 | docker |
| A27.seven_to_three | 全局保留七天可修改为三天 | docker |
