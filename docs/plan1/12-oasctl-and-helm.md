# 12 在已有 Kubernetes 集群上安装与升级

`oasctl` 是 OpenAgentSearch 的运维命令行。运维人员指定已有集群的 kubeconfig 上下文、命名空间和 Helm release。首版提供安装、升级、状态和诊断四个命令。Helm Chart 定义前端、Rust API、PostgreSQL 和 Firefox 执行器的期望状态；`searxng.enabled` 与 `crawl4ai.enabled` 各自默认关闭。

| 命令 | 输入、动作和成功条件 |
| --- | --- |
| `oasctl install` | 读取 Chart 版本和 values，检查目标 release、必需 Secret 引用和存储配置，运行数据库迁移，等待基础工作负载及已启用组件就绪，核对 API 就绪响应。已有同名 release 时报告当前状态，引导使用升级命令。 |
| `oasctl upgrade` | 读取原 release 配置，合并本次显式修改，校验迁移与版本兼容性，执行升级并核对迁移、工作负载和 API 就绪状态。普通升级保留数据库卷、主加密密钥、项目 Key 和已保存的项目及接入点配置。 |
| `oasctl status` | 展示目标 release 和修订、数据库迁移版本、API 就绪状态、Firefox 的期望及就绪副本数。SearXNG、Crawl4AI 分别显示未启用、就绪或不可用。 |
| `oasctl doctor` | 只读检查目标集群的可达性和权限、配置及 Secret 引用是否存在、卷绑定、迁移状态、Firefox 实例发现及已启用组件的连通性。逐项给出结论，权限不足的检查标为无法核验。输出仅含引用及状态。 |

四个命令用 `--kube-context`、`--namespace`、`--release` 指定同一个目标。安装和升级另接受 `--chart-version`、`--values` 与 `--timeout`。以下是设计中的调用形式，`site-values.yaml` 为部署方维护的配置文件。

```sh
oasctl install --kube-context my-cluster --namespace search --release oas --values site-values.yaml
oasctl status --kube-context my-cluster --namespace search --release oas
oasctl upgrade --kube-context my-cluster --namespace search --release oas --values site-values.yaml
oasctl doctor --kube-context my-cluster --namespace search --release oas
```

### 副本数与可选组件

```yaml
browser:
  replicas: 3
history:
  retentionDays: 7
searxng:
  enabled: false
crawl4ai:
  enabled: true
```

`history.retentionDays` 为首次安装初始化一份全局历史设置，默认 7 天，接受大于零的整数。新记录创建时固定生效的天数和到期时间，完整材料、调用和统计贡献继承所属请求的期限。升级保留用户已保存的设置。历史清理限于请求、回放、调用与统计，项目配置、凭据和正在用于调度的出口状态各自按生命周期管理。[保留与回放](06-observability.md#evidence)

这个例子要求 3 个 Firefox Pod，并启用 Crawl4AI。运维调整 `browser.replicas` 即可扩缩容，项目引用的两个内置能力 ID 保持稳定，新就绪 Pod 自动承接已有项目的搜索、正文任务。Atlas 运行观测显示每次实际使用的 Pod。可选组件只在相应开关启用时创建工作负载和 Service。采用集群外的 SearXNG 或 Crawl4AI 时，项目可配置相应实例的原生 HTTP 接口。[实例发现](01-system.md#browser-discovery)

### 失败、重试与升级验收

命令满足目标返回 0，写入失败、超时或必需检查未能完成时返回非零，同时报告阶段、目标 release 和可查到的迁移状态。遇到中断或结果未知，重试先查询已部署的修订和已应用的迁移。迁移按版本幂等执行。回退应用版本前检查与现有库结构的兼容性。迁移完成和 API 就绪是两项独立的检查。[服务启动与就绪](01-system.md) · [Helm upgrade](https://helm.sh/docs/helm/helm_upgrade/)

升级后，用升级前签发的项目 Key 发起业务请求，确认已配置的接入点凭据有效，并核对项目配置和已保存的数据。分别覆盖调整 Firefox 副本、单独启停可选组件、迁移失败和超时重试。测试环境清理须显式指定本轮专用 release 和资源范围，销毁本轮测试卷、容器和镜像。[全栈验收](09-rust-and-acceptance.md)
