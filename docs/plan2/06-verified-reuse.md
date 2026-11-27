# v2 列表复用判断器

`OAS_CACHE_HANDLER=v2` 将原问和实际执行的搜索变体接入材料复核。项目缓存开关、同题快照数量、Top K/Top N 后补文及 2/1/0 引用规则见[缓存主流程](README.md)。v1 使用原有余弦策略，适合沿用已有配置的安装。v2 用现有 Qdrant 索引端口和独立的系统匹配器。当 Handler 版本切换时，按原有机制启用新的缓存空间。

## 选源与截止

1. 词项与向量各召回 20 个逻辑问题。PostgreSQL 校验项目、来源、访问代次、撤下状态、可用材料及 TTL。语言、站点、地区、显式时间、词义问题中明示的目标字，以及明确冲突的产品版本参与兼容判断。产品版本缺失时用已授权标题、简介或当前页级摘要核实。真实日期条件、滚动发布时间窗口仍须满足。
2. 每条召回通道用一基名次记分，两路贡献按 `1/(60+rank)` 相加，同分按稳定问题 ID。合格的原问可以按 ID 确认。其余逻辑问题选融合后的前 8 个，每题从最多两份快照交替选取至多三个不同页面。标题、简介和摘要均相同的材料只送审一次。每项保留最多 160 字符标题、320 字符短简介、320 字符已有摘要。完整正文和密钥不进入复核。无项目配置的生成模型时，原生长简介仍可使用。
3. 每个实际查询只发一个候选批次。服务固定召回 embedding 版本、分类头、编码器、材料格式和语言阈值的 SHA-256 配置指纹。分类为 `reusable` 且得分达到该语言阈值才有近义复用资格。`insufficient` 表示相关但材料不足，`conflict` 表示动作、对象、限定条件或事实有冲突。没有经过校准的语言会直接返回空阈值和空判定列表，无需占用推理槽。离线评测可以对这些语言单独测量排序。语言桶按请求 `language` 的主标签确定，未传语言属于 `und`，可在该桶上训练和单独校准。
4. 复核结束后重读候选并核对快照身份和实际送审的材料包，撤权、撤下、过期或材料换版会使该来源退出交付。精确原问优先占一个位置，其余通过来源按可复用得分、融合名次排序。两个合格来源各投一票，一个异题来源按原规则异步补搜，零个合格来源由项目前台实搜。
5. embedding、双路召回、材料复核、读回和排序共用查询原截止，默认两秒并留出精确降级时间。服务繁忙、版本不符、回包不完整、超时等依赖故障走精确降级，缺少合格原问快照则走故障旁路。正常拒绝属于普通零命中。管理追踪的 `verification` 包含配置、送审候选 ID、已执行的分类及得分、阈值、耗时或降级原因。任务和快照不会保存可跨请求直接套用的分类判定。

## 训练和验收数据

每行 JSONL 表示一次真实查询及其候选，候选按 RRF 名次排列。同一业务请求的多个查询变体可共享 `request_id`，一起计算一次是否存在错误复用。省略该字段时每个查询独立计量。同一行最多八题，每题材料采用服务线上截取格式。`family` 是脱敏后稳定的语义问题族。同一意图、改写及同源切分材料归入同族。`exact_present` 可选，已有精确来源时，近义来源最多再占一个位置。以下单行示例为训练格式。

```json
{"family":"ubuntu-unity-startup","query":{"text":"Ubuntu 13.04 登录后 Unity 无法启动","language":"zh"},"candidates":[{"question_id":"s1","question":"Unity 启动故障如何排查","materials":[{"title":"Ubuntu 13.04 Unity 启动指南","snippet":"说明登录后桌面未出现的排查步骤","summary":null}],"label":"reusable"}]}
```

标注者判断已有页面是否能服务当前问题。可复用、材料不足、明确冲突三种标签均须进入训练。校准和独立审计集要保留真实频率、无匹配请求、双来源、易混淆动作/实体/版本及多候选竞争。对公开实验，XNLI 的蕴含/中立/矛盾、SQuAD 2.0 与 DuReader-Checklist 的可答性以及公开问句对属于代理监督。业务上线精度需要实际缓存快照的脱敏标注。[XNLI](https://aclanthology.org/D18-1269/) · [SQuAD 2.0](https://rajpurkar.github.io/SQuAD-explorer/) · [DuReader-Checklist](https://github.com/baidu/DuReader/tree/master/DuReader-Checklist)

```sh
python -m pip install -r apps/cache-matcher/training-requirements.txt
python apps/cache-matcher/prepare.py data/model
EMBEDDING_VERSION=填写管理接口缓存概览的embedding.version
python apps/cache-matcher/train.py --embedding-version "$EMBEDDING_VERSION" --model data/model --train train.jsonl --calibrate calibrate.jsonl --audit audit.jsonl --dataset labelled-snapshots-v1 --output data/profiles
PROFILE_ID=填写训练输出的64位指纹
python apps/cache-matcher/evaluate.py --model data/model --profile "data/profiles/$PROFILE_ID.json" --data heldout.jsonl --output evaluation.json
```

准备工具校验固定的双语 BGE-reranker-v2-m3 INT8 文件和 tokenizer 摘要，导出最后分类层之前的 1024 维成对表示。训练工具在冻结编码器上学习一个三分类头。当前问句、历史问句和各条材料独立分配 token 空间，问句限定超出完整输入预算会放弃复用。实际运行最多一批八个材料包，单个进程忙时返回 503。

默认目标是**近义复用请求中，含错误来源的请求占比至多 1%**。一次双命中有一个错误来源就整次计错。校准集选择满足目标的最大覆盖率阈值，独立审计集对固定阈值计算单侧二项上界，默认总体置信水平 95%，按语言桶数量校正。一族一语言在每个校准或审计阶段只取一个业务请求，保留该请求的全部查询变体。错误上界超标、样本不足或没有放行样本时，该语言阈值为空。此上界依赖独立、有代表性的审计样本。反复调整模型时应预留新的独立审计集。风险目标可用 `--target-error` 调整，审计报告同时给出样本数、错误数、来源召回和阈值。最终验收分别查看候选 Recall@20、同错误复用目标下的命中覆盖、错误双命中及端到端 P95/P99。

公开语料复现可先使用[配置与验证](05-runtime.md)的编码器工具准备 AskUbuntu 和 LCQMC，再运行 `python tests/cache-matcher-public.py data/public --question-benchmark artifacts/plan2-validation`。该工具按问题族生成 `train.jsonl`、`calibrate.jsonl` 和 `audit.jsonl`，另存旧公开问句工作负载为 `heldout-questions.jsonl`。将这四个文件传入以上训练和评测命令。需要 pyarrow 和 requests 读取公开数据。实际数据库工作负载可设置 `OAS_CACHE_HANDLER=v2` 和匹配器连接配置运行 `public_labeled_question_recall`。报告 `verified-public-recall.json` 分开统计送审候选正例、完成请求、实际推理、超时回源、最终交付和延迟。当前模型及阈值属于指定的已标注分布，代理数据的验证结果单独记录。

## 运行与版本切换

```sh
python apps/cache-matcher/serve.py --model data/model --profile "data/profiles/$PROFILE_ID.json" --port 8092
docker build -t oas-cache-matcher:local apps/cache-matcher
docker run --rm -p 127.0.0.1:8092:8092 -v "$PWD/data:/data:ro" oas-cache-matcher:local --model /data/model --profile "/data/profiles/$PROFILE_ID.json"
```

本机和 Docker 是两种启动方式。训练命令打印 `profile`。API 的 `OAS_CACHE_MATCHER_URL` 填完整的 `/v1/cache/match` 地址，`OAS_CACHE_MATCHER_PROFILE` 填相同的指纹。可用 `OAS_CACHE_MATCHER_API_KEY` 在双方设置 Bearer 密钥。`GET /health/ready` 在模型完成一次本地预热推理后返回已装载的指纹。Helm 内置部署使用 `cache.matcher.image`、`existingClaim` 和 `profile`，将同一目录结构预置在 PVC 内。匹配器独立于项目生成模型和 embedding 接入点。切换分类头、材料格式或阈值时重新发布配置指纹并更新 API，部署版本不一致的请求沿用故障降级。[匹配器 OpenAPI](cache-matcher.openapi.yaml)

建模方法参考 [RRF](https://cormack.uwaterloo.ca/cormack/cormacksigir09-rrf.pdf) 与 [vCache](https://proceedings.iclr.cc/paper_files/paper/2026/hash/9559cd2116de7a8f5672eac3fcd232cc-Abstract-Conference.html)。本实现以独立问题族的快照复用审计作为上线依据。
