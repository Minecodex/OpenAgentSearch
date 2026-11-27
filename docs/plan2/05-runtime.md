# 缓存配置与验证

Plan 2 已接入列表、正文、综合、管理员测试和后台调度。项目创建/编辑中的 `cache_enabled` 默认关闭；系统依赖就绪后仍须逐项目开启。管理台的“缓存管理”菜单提供库存、命中率、队列、任务详情、双热点策略、后台浏览器并发和模型预算。

## 配置入口

系统 embedding、存储连接、TTL 和容量通过环境变量或 Helm 配置。管理台不保存 embedding 密钥。完整模板见 [环境变量](../../.env.example) 和 [Helm values](../../deploy/helm/openagentsearch/values.yaml)。

| 环境变量 | 默认值 / 含义 |
| --- | --- |
| `OAS_CACHE_HANDLER` | 默认 `v1`。设为 `v2` 启用材料复核策略，切换 Handler 创建新空间和任务代次 |
| `OAS_CACHE_EMBEDDING_BASE_URL / MODEL / DIMENSIONS / VERSION` | 必填的实际服务配置；兼容 `/v1/embeddings`，返回浮点向量，批量最多 32 项；API key 独立注入 |
| `OAS_CACHE_MATCH_THRESHOLD` | v1 的余弦阈值，默认 0.92 |
| `OAS_CACHE_MATCHER_URL / PROFILE / API_KEY` | v2 的完整 `/v1/cache/match` 地址、64 位小写十六进制配置指纹及可选 Bearer 密钥。URL 和指纹均未配置时仍可精确复用。近义判断需要两个值配套 |
| `OAS_CACHE_QDRANT_URL / API_KEY` | Qdrant 1.20+，使用原生 BM25 文本索引及向量召回；两路各 20 项 |
| `OAS_CACHE_QDRANT_SHARDS / REPLICATION_FACTOR` | `1 / 1`，新 collection 的分片与副本数；不自动重分片已有 collection |
| `OAS_CACHE_VALKEY_URL / PASSWORD` | 可选热点镜像；PostgreSQL 保持可靠计数和榜单，镜像故障不会丢失已落库统计 |
| `OAS_CACHE_VALKEY_CLUSTER_NODES` | 逗号分隔 Redis URL，使用集群客户端；密码来自独立变量，键按项目与分片分布 |
| `OAS_CACHE_S3_ENDPOINT / REGION / BUCKET / ACCESS_KEY / SECRET_KEY` | S3 兼容正文对象存储；region 默认 `us-east-1`，HTTP 仅供受控内部部署 |
| `OAS_CACHE_LOOKUP_TIMEOUT_MS` | `2000`，包含编码、混合召回、快照、排序及精确降级的共享预算 |
| `OAS_CACHE_LIST_TTL_SECS / CONTENT_TTL_SECS` | `1800 / 21600`，均须大于 0，按真实派发时间计算；读取及生成摘要不续期 |
| `OAS_CACHE_SUMMARY_MAX_INPUT_TOKENS` | `8192`，只取规范化正文前缀，仍受项目模型上下文限制；简介输出最多 1000 token |
| `OAS_CACHE_QUEUE_CAPACITY` | `1024`，满时淘汰最老等待项，不淘汰运行项 |
| `OAS_CACHE_TASK_MAX_ATTEMPTS / TASK_TTL_SECS` | `3 / 1800`，只计真实派发轮次；重试和合并不延长首次入队的绝对截止 |
| `OAS_CACHE_MAX_OBJECT_BYTES / MAX_SNAPSHOTS` | `10 GiB / 100 万`，应用容量上限；Helm 小规格另配 `8 GiB / 10 万` |

统计写入使用最多 3 个独立 PostgreSQL 连接，遇到登记或记票锁等待时允许跳过该样本。

后台列表任务保留综合查询的地区身份并按原始检索文本访问内置浏览器。公开列表接口沿用原有入参。

后台浏览器并发保存值 `C >= 1`，生效值为 `min(C, max(0, 就绪标签数 - 1))`。就绪标签不足两个时暂停派发，保存值保留；前台等候时后台让出派发机会。后台模型默认每个端点并发 1、每分钟 10 次，同时遵守端点总额度。管理配置使用 `expected_version`，冲突后重读。

## 存储和部署

设置 `cache.enabled=true` 可部署带 PVC 的 Qdrant、Valkey 和 SeaweedFS S3。默认每个依赖单副本，适用于开发和小规模部署。Qdrant 的完整向量、payload 与 HNSW 使用磁盘存储；PVC 的介质由 `storageClassName` 决定，生产按实际 SSD/NVMe、RAM 和尾延迟选择。

[集群覆盖配置](../../deploy/helm/openagentsearch/cache-ha.example.yaml) 展示 3 个 Qdrant 节点、6 个分片、2 份副本，多副本 StatefulSet 通过主机名硬反亲和将每个 peer 放在独立节点，并连接外部 Valkey Cluster 和 S3。外部依赖需独立部署及备份；内置单副本 Valkey/SeaweedFS 不提供生产高可用。索引扩容不改变 API 的单一调度所有者边界。

`cache.existingSecret` 的键为 `qdrant-api-key、valkey-password、s3-access-key、s3-secret-key`，embedding 可引用独立 Secret。未提供时为内置依赖生成并沿用 Secret。密钥不写入日志和管理台响应。已有资源的密钥轮换应同时更新客户端和对应服务。

对象配额以 PostgreSQL 事务计数核算。上传预留原子增加字节数，超额回滚；撤下指针后字节仍计入配额，物理删除得到确认后释放。快照按问题批量校验来源、撤下状态和引用资格，索引回收只锁本批涉及的点。应用按 90%/80% 高低水位提前撤下冷快照及正文，保护在途读取、活动发布和已冻结历史材料。正文哈希用于派生简介复用；每次上传使用新的不可复用对象地址，防止进程重启后的迟到删除影响后续上传。对象删除有 5 分钟发布宽限期。提前淘汰按仍挂有指针的字节数计算到 80% 的差额，物理配额在删除确认后释放。孤儿回收先核对指针和读租约。索引中过期点批量回收，旧命名空间及旧编码空间只清理本数据库登记的 collection。Qdrant 的磁盘配额应在每个节点启用；内置配置初始设为 90% 高水位，保留 10% 回落余量。外部集群应由运维配置自身节点配额，应用不修改共享集群的全局配额。索引写受限时缓存失败隔离，正常请求继续项目路由。

正文和查询在缓存入库前去除已知密钥；包含当前资源密钥的输入旁路缓存。访问配置变化会递增独立访问代次，旧来源材料退出复用；模型变化只使旧派生简介失配，允许重新总结现有正文。URL 使用固定长度哈希身份，保留未知片段和 SPA 路由。首版对未证实的普通锚点保守保留，不主动访问页面来确认合并。

## 验证与压测

运行 `node tests/local.mjs` 会在独立 Docker 网络创建 PostgreSQL、Qdrant、Valkey、S3、API、Firefox 和前端，执行 Rust 单元/存储测试、API、浏览器和双语深浅色 UI E2E。结束时清理该次创建的容器、卷和镜像。`tests/acceptance/cache.mjs` 覆盖原始 10 条快照、2/1/0 和自身例外、后台内置补搜、所选页补文、S3 正文命中、2 秒超时、并发和项目开关。

`node tests/cache-benchmark.mjs queries.jsonl 4 artifacts/cache-benchmark.json` 使用 `OAS_BENCH_API_KEY` 指定专用项目，记录列表 API 的端到端 P50/P95/P99 和请求 ID。JSONL 每行是一个实际列表请求；应分别输入冷问、精确重复问和已标注的相似问。请求历史中的 `cache_lookup` 阶段可与端到端延迟分开分析。该工具会实际搜索及消耗所配模型额度。大规模召回质量、磁盘冷启动、节点故障恢复和生产容量仍须用真实脱敏样本与目标硬件测量；本地夹具不代表生产召回质量或容量。

通过 `cache.matcher.url/profile` 连接外部判断器，密钥可引用 `cache.matcher.existingSecret/secretKey`。内置部署设 `cache.handler=v2`、`cache.matcher.enabled=true`，提供运行镜像和只读 PVC，API 自动使用集群地址。挂载布局和训练命令见[列表复用判断器](06-verified-reuse.md)。

### 公开语料召回与高可用验证

安装 Python 依赖 numpy、onnxruntime、tokenizers、pyarrow 和 requests，运行 `python tests/cache-public-corpus.py artifacts/plan2-validation`。该工具下载固定版本的 AskUbuntu 重复问题、LCQMC 测试集和量化的 multilingual-e5-small，并在本地提供 384 维 embedding。每种语言各抽取 0、1、2 个已标注相关候选的查询组，每组单独建项目。指标以组内人工标注为准。[AskUbuntu](https://huggingface.co/datasets/mteb/askubuntudupquestions-reranking) · [LCQMC](https://huggingface.co/datasets/C-MTEB/LCQMC)

将测试进程的 `OAS_CACHE_BENCH_DIRECTORY` 指向生成的目录，按上表将 embedding URL、模型、维度和 Qdrant 指向测试服务，并指定一次性 PostgreSQL 的 `OAS_TEST_DATABASE_URL`（专用数据库主机名含 `oas-plan2-db`）。执行 `cargo test -p oas-adapters --features database-tests --test cache public_labeled_question_recall -- --ignored`。输出的 `public-recall.json` 包含各语言精确率、召回率、错误双命中、漏双命中和实际缓存检索延迟。同目录的 `comparison/questions.json` 使用独立种子并排除首批查询，供不同阈值对照。将目录切到 `comparison` 并设置 `OAS_CACHE_MATCH_THRESHOLD` 即可重复运行。容器访问本机编码器时，按测试网络设置编码器的 `--host`。

`node tests/cache-ha.mjs` 使用 kind、Docker、kubectl 和 Helm 创建临时三节点集群，部署 HA 配置并核对节点分布，停掉一个承载分片的工作节点验证读连续性，恢复节点后验证已有数据和新写入。可用 `OAS_KIND` 指定 kind 路径。节点和临时凭据随测试清理。
