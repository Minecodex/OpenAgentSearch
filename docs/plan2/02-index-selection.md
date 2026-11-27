# Qdrant 索引与自托管部署

**Plan 2 已选用自托管 Qdrant。** 同一集合检索历史问题的稠密向量和带 BM25 评分的问题文本，按项目、语言、可见范围及有效期过滤。采用支持原生 BM25 全文评分的 Qdrant 1.20 或以上版本。应用为新问法生成一次稠密 embedding，词项一路由 Qdrant 的全文索引完成。部署时固定已验证的服务端镜像和 Helm Chart 版本。[Qdrant 1.20 全文检索](https://qdrant.tech/blog/qdrant-1.20.x/) · [混合查询](https://qdrant.tech/documentation/search/hybrid-queries/)

<a id="deployment"></a>

## 部署难度与依赖

已有 Kubernetes 和 Helm 时，单节点验证只增加 **1 个 Qdrant Pod 和 1 个数据 PVC**。高可用建议 **3 个 Qdrant Pod、3 个独立数据 PVC**，副本跨宿主机放置。两种规模使用同一服务镜像。Qdrant 内建负责集群拓扑和集合结构的 Raft，无需另部署 etcd、ZooKeeper、消息队列或外部数据库来启动索引服务。[本地单容器示例](https://qdrant.tech/documentation/quickstart/) · [官方 Helm Chart](https://github.com/qdrant/qdrant-helm) · [自托管集群](https://qdrant.tech/documentation/scaling/distributed_deployment/)

| 场景 | 需要准备 | 主要工作 |
| --- | --- | --- |
| 开发与功能验证 | 单容器或单 Pod，`/qdrant/storage` 挂一块持久化 SSD/NVMe 数据卷 | 创建问题集合和过滤字段索引，验证稠密向量与中文 BM25 两路召回、写入可见性及重启后数据可读 |
| 生产高可用 | 官方 Helm Chart 的 StatefulSet，建议起步 3 个 peer，每个 peer 一块 SSD/NVMe 数据 PVC，业务集合设置 `replication_factor=2` 或更高 | 检查每个分片的副本确实分布在不同节点。3 个 peer 中保有 2 个可维持集群管理操作的多数。数据读写可用性还取决于分片副本和一致性设置。[高可用建议](https://qdrant.tech/documentation/scaling/resilience/) |

在线数据卷应为带 POSIX 文件系统的块存储，可用本地 NVMe，也可验证云 SSD 块卷。NFS 共享目录和 S3 桶不能作 Qdrant 主数据盘。应用按协议访问集群内的 REST `6333` 或 gRPC `6334`，peer 间通过内网 `6335` 通信。生产运维的主要工作是分片迁移和恢复。新增节点后检查现有分片的落点，自托管改变已有集合的分片数要预留新集合迁移空间。分布式集合按节点取快照，副本和集群外备份分别覆盖节点故障和数据恢复。[存储要求](https://qdrant.tech/documentation/installation/) · [横向扩展](https://qdrant.tech/documentation/scaling/horizontal-scaling/) · [分布式快照](https://qdrant.tech/documentation/snapshots/)

**完整缓存涉及 Qdrant、Valkey 和正文对象存储。** 已有 PostgreSQL 保存配置与任务。系统统一 embedding、项目模型生成页级原语言简介。已取得列表和完整正文直接缓存，原始候选保存完整；额外浏览器取文和页级简介生成只由实际返回/选用页面触发，已有正文热点维护独立执行。本期 TTL 使用固定配置。[复用与范围](README.md#producers) · [固定 TTL](README.md#cache-ttl)

## 索引和数据放在哪里

缓存通过应用层定义的存储端口访问下表中的组件。Handler 版本控制策略，存储适配器负责索引、对象和任务记录的实际读写。只启用当前 Handler，切换采用新缓存空间，旧空间不再命中、写入或参与热点扫描。装配和任务忽略规则见[Handler 架构](04-cache-architecture.md)。

项目通过界面中的 `cache_enabled` 单独启停，默认关闭。关闭项目不执行缓存 embedding/索引访问、写入或后台维护，保留材料按原 TTL 和容量规则回收。项目开关及内部代次保存在已有 PostgreSQL 项目配置中，开关变化不重建系统索引或改变 Handler 的活动空间。[项目开关](README.md#project-cache-switch)

| 组件 | 建议落点 | 在线访问方式 |
| --- | --- | --- |
| 问题倒排、向量及过滤字段 | 系统统一 embedding 和活动索引版本，在每个活动缓存空间内，每项目每个逻辑 `question_id` 对应一个 point。BM25 索引问题文本，payload 索引支持缓存空间、项目、语言和有效期过滤 | point 身份或集合隔离必须包含缓存空间。混合查询只用活动空间及相同版本的向量。精确降级也按该空间读取并重验全部条件，检索与统计仍按项目隔离 |
| 实搜快照及候选特征 | 每个真实查询保存完整原始榜单，含接入点/服务商、`call_id`、适用时的浏览器作业、原排名、时间、覆盖和完整度。特征按文本哈希及模型版本复用 | 任意来源的原始结果可入库，项目最终显示数量不裁剪原始快照。[数量边界](README.md#counts) |
| 正文和 AI 简介 | 已取得的有效完整正文按来源、采集时间/序号、哈希和页面身份存版本，元数据记录固定 TTL 到期时刻 | 最新有效采集覆盖当前页，实际使用时关联其原语言简介。只有实际返回/选用的页缺少可复用正文时才主动补文；已取得全文照常直接缓存。[正文更新](README.md#current-version) |
| 全量逻辑名册、累计与近期排行 | 含业务列表、综合原问/实际检索变体及管理员调试/测试的独立来源标识。未入库、已过期和零引用对象均计入所属范围的全量分母 | 两榜以全量计算上限，只取各榜正分。Valkey 聚合已可靠记录的事件，可从持久检查点重放。无法可靠记录时允许少计、用户正常取得结果 |
| 管理配置、任务协调与历史请求 | PostgreSQL 保存活动 Handler/缓存空间/启用代次绑定、缓存策略、后台浏览器并发配置版本、任务状态与租约 | 管理员在[缓存管理](03-cache-console.md)调节全局并发。唯一调度所有者核验活动绑定及实际容量，索引扩容不放大后台上限。每轮按最新项目及资源配置派发 |

同缓存空间内，同查询和 embedding 版本沿用向量，原始列表按来源与代次直接缓存。活动代次中的最新有效正文按采集次序覆盖当前版本，旧采集迟到不回滚，非活动 Handler 的结果不发布。原生长简介随语义命中的条目复用。后台只对本次实际返回/选用的页补缺文，后台列表刷新只存榜单及随附材料，不继续预取新链接。[按需范围](README.md#counts) · [版本覆盖](README.md#current-version) · [更新 payload](https://api.qdrant.tech/api-reference/points/set-payload)

<a id="embedding-version"></a>

### 系统统一 embedding 与模型换版

系统级配置固定一个活动模型及其版本、输出维度、距离度量和归一化方式，所有项目使用同一向量空间。请求开始时固定索引代次和对应编码器。项目侧只管理原有授权、数据可见范围和生成模型。

- **问题与网页分两级评分。** 用问题向量与倒排召回历史问题。任意实际来源的原始快照入库时可编码候选标题和简介，按文本哈希及系统模型版本存特征。前台在已选候选中计算语义、词项和原排名信号，页面采用最高分的成套材料。项目最终返回条数不裁原始特征集，容量单列其写入、磁盘和读取成本。
- **v2 列表复用。** 两路各取 20 个，按逻辑问题 ID 保留各路一基名次。等权 RRF 以 `1/(60+名次)` 求和，单路候选保留该路贡献。批量复核有材料的前 8 个相似问题。精确原问可单独核验。语义判定使用随模型固定的分类头与分语言阈值。[复核与校准](06-verified-reuse.md)
- **切换版本。** 用现有合格快照的文本在新的索引代次重算问题及候选向量，追平期间的新增、过期和撤权记录。核对覆盖度、第二条召回率和错误双命中后，把编码器、索引和相应阈值作为一个活动版本切换。在途请求固定其原版本，完成后再回收旧索引。相同维度的不同模型也不可混用。逻辑问题 ID、历史热度和完整正文均可沿用，无需重新访问网页。
- **故障。** 仍能按 ID 读取时，严格匹配的原问允许降级交付。没有这样的快照或 Qdrant 无法读取时，在原请求截止内回到项目路由。单路词项排名不自行取得高置信资格。[降级判定与计量](README.md#degraded)

```mermaid
flowchart TD
    Q["当前问题和有效检索条件"] --> H["系统统一 embedding 与 Qdrant BM25"]
    H -.->|无法完成混合判定| XH{"可精确读取并满足交付？"}
    XH -->|是| DH["降级交付本题"]
    XH -->|否| F
    Q -.-> C["按逻辑问题 ID 登记全量名册"]
    H --> I{"有可交付快照的高置信逻辑问题数"}
    I -->|单或双命中| L["取全所选快照的候选，去重评分并按用途取前列"]
    I -->|零命中同步| F["按项目路由取得真实查询结果"]
    F --> R["取得原始查询榜单和已有完整正文"]
    R --> G
    R --> M["完整正文按采集次序发布当前版本"]
    M --> D
    F -.->|实际失败且无可复用材料| S["后台内置浏览器实搜"]
    I -.->|非豁免单命中，每次提交| S
    L -.-> E["尽力记录实际引用，失败仍正常交付"]
    E --> T["同一全量分母，分别选正分对象"]
    C -.-> T
    T --> W{"到期且入选任一榜的对象"}
    W -->|问题| S
    W -->|正文| P["内置浏览器仅补缺失或过期正文"]
    S --> R
    G{"达 5 条有效链接或有已完成引擎 AI 回答？"}
    G -->|原始结果合格| V["按实际接入点来源发布查询快照"]
    G -->|未通过准入| X["结束本次写入，已有快照不续期"]
    V -.-> H
    L -.->|仅对实际返回或选用页补缺文| P
    P --> D["对象存储保存正文版本"]
```

## 选型依据与备选记录

| 方案 | 磁盘、双路检索和分布式能力 | 影响选型的差异 |
| --- | --- | --- |
| **Qdrant（已选）** | 在同一个检索服务内支持稠密向量与 BM25，可分别配置量化副本、原始向量和索引的内存层级。支持分片和节点间复制 | 用真实问句校准中文分词、代码标识和版本号的匹配效果。按自托管约束规划初始分片，预留集合迁移和恢复空间。[混合检索](https://qdrant.tech/documentation/search/hybrid-queries/) · [全文打分](https://qdrant.tech/documentation/search/text-search/full-text-search/) · [内存分层](https://qdrant.tech/documentation/ops-configuration/memory-tiers/) · [横向扩展](https://qdrant.tech/documentation/scaling/horizontal-scaling/) |
| **OpenSearch** | 文本倒排和 k-NN 可做混合召回。`on_disk` 模式可先查压缩索引，再从磁盘取少量完整向量复算。主分片分布数据，副本承担读取与冗余 | 适合中英文技术词和向量信号同等重要的场景。内置 CJK 分析器按二元词切分，还应验证版本号、错误码、别名和 ICU 分析效果。自托管可用集群外快照仓库做恢复演练。[磁盘检索](https://docs.opensearch.org/latest/vector-search/optimizing-storage/disk-based-vector-search/) · [混合查询](https://docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/index/) · [分片路由](https://docs.opensearch.org/latest/search-plugins/searching-data/search-shard-routing/) · [CJK](https://docs.opensearch.org/latest/analyzers/language-analyzers/cjk/) · [快照恢复](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/) |
| **Milvus Distributed** | 稠密向量支持 DiskANN，官方建议为相关数据目录提供快速 NVMe SSD。支持 BM25 全文检索，集群组件可以分别扩容 | 适合向量规模或建索引吞吐成为主成本的场景，需考虑分布式组件、持久化依赖、索引追赶和整套恢复的运维成本。[DiskANN](https://milvus.io/docs/diskann.md) · [BM25](https://milvus.io/docs/full-text-search.md) · [组件架构](https://milvus.io/docs/architecture_overview.md) · [扩容](https://milvus.io/docs/scaleout.md) |
| **Elasticsearch** | 文本与向量排名可融合，DiskBBQ 提供磁盘上的压缩向量检索，集群支持主分片、副本和集群外快照 | 优势在于复用已有 Elastic 集群、监控和恢复流程。采用 DiskBBQ 时需核对拟部署版本及许可。[DiskBBQ 与许可条件](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/bbq) · [混合排名](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion) · [节点和分片](https://www.elastic.co/docs/deploy-manage/distributed-architecture/clusters-nodes-shards) · [快照](https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore) |
| **Vespa** | 支持文本与稠密信号组合、多阶段排序，内容节点增减时可在线重分布并维护副本 | 适合需要复杂排序表达式的系统。官方明确提醒 `paged` 张量与 HNSW 组合在内存紧张时会因随机访问拖慢写入，需为其规划内存工作集。[混合搜索](https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html) · [分页属性的限制](https://docs.vespa.ai/en/content/attributes.html#paged-attributes-disadvantages) · [在线扩容与恢复](https://docs.vespa.ai/en/content/elasticity.html) |

备选方案的公开容量数据可作量级参考。OpenSearch 2.18 在 1.13 亿条 1,024 维向量、10 个带本地 SSD 的数据节点、8 倍压缩的测试中，预热后 8 客户端向量检索 P90 为 95.05 毫秒，Recall@100 为 0.98。Qdrant 的目标工作负载还包括中文短问句、授权和时效过滤、置信度判定及列表读取，需要独立测量。[OpenSearch 测试配置与结果](https://opensearch.org/blog/reduce-cost-with-disk-based-vector-search/)

## 固态盘与索引速度

- **工作集。** 完整向量、倒排文件和列表快照持久化在 SSD/NVMe。给压缩向量、索引热页及文件系统页缓存预留 RAM。记录 Kubernetes 持久卷的实际介质、随机读 IOPS 和尾延迟。若生产候选同时包括本地 NVMe 与网络 SSD 卷，两种存储分别测冷启动、稳定读和并发写。以 1,000 万个真实历史问题、768 维 `float32` 为例，单份原始向量约 30.72 GB，另计图索引、倒排、元数据、副本、段合并及恢复空间。
- **少漏掉第二个问题。** 两路可各取前 20 个作为起测值。为项目、语言和时间条件建立对应的 payload 索引，并在两路检索时过滤。两路按 ID 合并后以置信度和快照状态放行。候选数、量化强度和磁盘复算深度要在相同的第二条漏召回率下比较。[Qdrant 的向量与 payload 索引](https://qdrant.tech/documentation/manage-data/indexing/)
- **并发写入。** 新问法沿用前台已算好的向量，实搜成功后按稳定 ID 发布。批量写入和清理过期记录，分别观察新点的查询可见性及后台建索引积压。如果启用 `indexed_only`，查询会跳过尚未建好索引的大段，近期写入的第二个问题可能暂时不可见。验收覆盖连续写入场景。每次命中的引用增量走独立计数路径。[Qdrant 索引优化器](https://qdrant.tech/documentation/ops-optimization/optimizer/)
- **分片和恢复。** 用项目或项目分区减少无关分片的查询扇出，大项目可跨分片。节点、数据卷和副本按故障域分布。节点扩容后的重平衡、滚动升级、单盘丢失和集群外备份恢复都要覆盖。恢复后以原始快照核对 ID、到期时间、权限、热点榜版本和计数消费进度，避免旧数据重新成为有效命中。

<a id="eviction"></a>

### 磁盘水位与提前淘汰

TTL 给出最晚可复用时间。Qdrant 的 SSD/NVMe 数据卷或正文对象存储达到容量高水位时，允许提前淘汰仍新鲜的冷缓存。分别观测节点/分片可用空间和对象存储配额，高低水位及安全余量由部署容量测试决定。回收到低水位后停止，避免反复剔除和填充。

1. 优先回收已过发布宽限期且确认没有指针或写入租约的孤立对象，接着回收已过期和未被引用的旧版本。列表、正文和派生简介分别核对版本关系。
2. 仍有压力时，优先淘汰榜外且近期少用、占用大的新鲜列表或正文。先按代次撤出可交付指针，再回收底层数据。移除一份快照后，若该问题还有另一份可交付快照，有效库存仍计该问题。轻量问题名册、累计数及近期桶独立保存，后续请求按实际可用源回到 2/1/0 路径。
3. 保护活动写入、在途读取和保留期内的回放证据。历史已独立冻结实际交付材料时，可回收缓存副本。若回放共用同一对象，则在最后一个有权引用到期后才删除。发布失败产生的孤儿经过宽限期再次核验，避免清理与新发布互相覆盖。
4. 安全可回收空间耗尽时暂停新增缓存写入，前台照常返回。运营指标区分“容量提前淘汰”“源站删除/撤权”“自然到期”和后台“队满淘汰”。提前回收不会触发该代快照的到期续写，恢复空间后可由真实需求重建。回放引用只保护物理留存，读取仍要通过当前权限和保留期检查。[历史材料与保留期](../plan1/06-observability.md) · [源站状态处理](README.md#origin-status)

<a id="validation"></a>

## Qdrant 容量与验收

同一批脱敏问题、同一 embedding、相同 SSD/NVMe、RAM 和副本预算下，对比 Qdrant 的索引及分片配置。样本保留真实的项目规模分布、冷热比例、中英文混合、版本号、否定词、相对日期以及双榜刷新写入。用精确向量扫描、完整词项检索和标注问句对建立高置信问题的对照集。高可用拓扑的建议起点见[部署难度与依赖](#deployment)，单节点规格及峰值所需节点数按实测确定。

| 验收维度 | 项目需要测的数据 |
| --- | --- |
| 质量与上游成本 | 缓存保留各查询完整原始候选，后台补文只看输出集合。30 个候选、列表返回 10 个时最多补 10 个；综合选 2 个且正文成功时额外补 0 个；简介模式选 2 个时只补这 2 个缺项。定时列表刷新不派整榜正文。验证固定 TTL、模型摘要不续期和原始材料直接复用 |
| 读速与写速 | 分开统计 embedding、混合索引、批量读取与端到端 P50/P95/P99。覆盖冷盘、热盘、到期批处理及节点重平衡。记录持续写入问题数/秒和新快照可检索延迟 |
| 容量与成本 | 每百万问题的 SSD、RAM、副本和备份占用，磁盘读负载及容量水位。演练 TTL 前淘汰、并发发布与孤儿回收、回放保护、轻量名册持续计数及写受限时的前台交付 |
| 可维护性 | 中文分析器配置、增加节点是否需要重建、升级与回滚、许可限制、备份恢复步骤、节点故障时可用范围及恢复时间 |

在满足磁盘持久化、跨节点部署及业务正确性的 Qdrant 配置中，按目标流量下的 P99、写入可见性、故障恢复和资源成本确定上线规格。
