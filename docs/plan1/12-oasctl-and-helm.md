# 12 在已有 Kubernetes 集群上安装与升级

`oasctl` 是 OpenAgentSearch 的运维命令行。运维人员指定已有集群的 kubeconfig 上下文、命名空间和 Helm release。首版提供安装、升级、状态和诊断四个命令。Helm Chart 定义前端、Rust API、PostgreSQL 和 Firefox 执行器的期望状态；`searxng.enabled` 与 `crawl4ai.enabled` 各自默认关闭。

| 命令 | 输入、动作和成功条件 |
| --- | --- |
| `oasctl install` | 读取 Chart 版本和 values，检查目标 release、必需 Secret 引用和存储配置，运行数据库迁移，等待基础工作负载及已启用组件就绪，核对 API 就绪响应。已有同名 release 时报告当前状态，引导使用升级命令。 |
| `oasctl upgrade` | 读取原 release 配置，合并本次显式修改，校验迁移与版本兼容性，执行升级并核对迁移、工作负载和 API 就绪状态。普通升级保留数据库卷、主加密密钥、项目 Key 和已保存的项目及接入点配置。 |
| `oasctl status` | 展示目标 release 和修订、数据库迁移版本、API 就绪状态、Firefox 的期望及就绪副本数。SearXNG、Crawl4AI 分别显示未启用、就绪或不可用。 |
| `oasctl doctor` | 只读检查目标集群的可达性和权限、配置及 Secret 引用是否存在、卷绑定、迁移状态、Firefox 实例发现及已启用组件的连通性。逐项给出结论，权限不足的检查标为无法核验。输出仅含引用及状态。 |

四个命令用 `--kube-context`、`--namespace`、`--release` 指定同一个目标。安装和升级另接受 `--chart-version`、`--values` 与 `--timeout`。以下是调用形式，`site-values.yaml` 为部署方维护的配置文件。

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

`history.retentionDays` 为首次安装初始化一份全局历史设置，默认 7 天，接受 1–36500 的整数。新记录创建时固定生效的天数和到期时间，完整材料、调用和统计贡献继承所属请求的期限。升级保留用户已保存的设置。历史清理限于请求、回放、调用与统计，项目配置、凭据和正在用于调度的出口状态各自按生命周期管理。[保留与回放](06-observability.md#evidence)

这个例子要求 3 个 Firefox Pod，并启用 Crawl4AI。运维调整 `browser.replicas` 即可扩缩容，项目引用的两个内置能力 ID 保持稳定，新就绪 Pod 自动承接已有项目的搜索、正文任务。Atlas 运行观测显示每次实际使用的 Pod。可选组件只在相应开关启用时创建工作负载和 Service。采用集群外的 SearXNG 或 Crawl4AI 时，项目可配置相应实例的原生 HTTP 接口。[实例发现](01-system.md#browser-discovery)

### 失败、重试与升级验收

命令满足目标返回 0，写入失败、超时或必需检查未能完成时返回非零，同时报告阶段、目标 release 和可查到的迁移状态。遇到中断或结果未知，重试先查询已部署的修订和已应用的迁移。迁移按版本幂等执行。回退应用版本前检查与现有库结构的兼容性。迁移完成和 API 就绪是两项独立的检查。[服务启动与就绪](01-system.md) · [Helm upgrade](https://helm.sh/docs/helm/helm_upgrade/)

升级后，用升级前签发的项目 Key 发起业务请求，确认已配置的接入点凭据有效，并核对项目配置和已保存的数据。分别覆盖调整 Firefox 副本、单独启停可选组件、迁移失败和超时重试。测试环境清理须显式指定本轮专用 release 和资源范围，销毁本轮测试卷、容器和镜像。[全栈验收](09-rust-and-acceptance.md)

### 凭据、就绪和迁移

首次安装创建 `<release>-credentials`，普通升级通过集群中的现有 Secret 保留管理员口令、主密钥、执行器令牌与数据库口令。自备 `credentials.existingSecret` 至少提供 `admin-username/admin-password/master-key/worker-key/postgres-password`；启用 SearXNG 再提供 `searxng-key`，启用 Crawl4AI 再提供 `crawl4ai-key`。关闭的可选组件不要求对应凭据。数据库连接使用分开的 PG 环境变量，原始口令直接传给数据库驱动，不经过 URL 拼接和解码。

每次修订创建普通迁移 Job，服务启动也验证并幂等应用迁移；迁移与初始管理员完成后才就绪。API 使用 Recreate 保证单一调度进程。API 失去数据库所有权连接后取消请求并退出，由 Deployment 重启。`status` 核对数据库迁移代次与 API 健康；`doctor` 只检查 Secret 引用及所需键的存在，不输出内容。源码构建和本地测试入口见[根 README](../../README.md)。

`api.extraEnv`、`browser.extraEnv`、`searxng.extraEnv`、`crawl4ai.extraEnv` 可注入部署环境的额外变量。`searxng.settings` 写入其原生 settings.yml，变更会触发该组件滚动更新。Pod 关闭 Kubernetes 隐式 Service 环境变量，前端显式指定 API 端口，release 名称不影响代理地址。

`doctor --json` 以机器可读结果逐项列出检查，任一失败或无法核验返回非零。发现权限针对 API Deployment 实际使用的 ServiceAccount 检查 EndpointSlice 的 list/watch 与 Pod 的 get；不能以执行命令者本人的权限替代。存储检查验证 PVC 为 Bound、PV 的 claim UID 对应，以及引用的 StorageClass 可读取。迁移核对当前修订的 Job 和数据库结构版本。运行诊断由 API 内部认证接口提供调度所有权、实例数量、诊断写入计数与原生可选组件的实际健康状态，不输出认证材料。SearXNG 或 Crawl4AI 已启用但健康接口不可达时显示 `component_unready`。

手工代理测试的固定目标及判定通过 `browser.extraEnv` 中的 `OAS_PROXY_TEST_URL`、`OAS_PROXY_TEST_EXPECTED_STATUS` 和可选 `OAS_PROXY_TEST_EXPECTED_BODY` 配置；所有执行器应保持一致，升级执行器后生效。Google 周期检测独立使用固定域名及 1800 秒周期，不受正文判定条件影响。详见 [代理诊断](./07-browser-proxies.md#手工测试的判定与诊断契约)。

### 初始管理员与显式口令重置

首次初始化默认账号为 `admin`，口令为 `admin123`。用户名不能为空或带首尾空白，口令至少 8 个 Unicode 字符且不能全为空白或包含换行。`oasctl install` 支持 `--admin-username`、`--admin-password`、`--admin-password-file`；后者接受 UTF-8 文件或 `-`（标准输入），移除文件末尾的一次 CRLF/LF。两个口令输入参数不能同时提供。也可使用 `OAS_ADMIN_USERNAME`、`OAS_ADMIN_PASSWORD` 环境变量。

初始参数优先于 `--values` 中的 `credentials.adminUsername/adminPassword`，之后才使用 Chart 默认值。仅用户名参数不会覆盖 values 中的口令。自备 `credentials.existingSecret` 时不能再使用初始账号参数，避免配置被静默忽略。CLI 将覆盖值写入仅当前用户可读的临时文件，向 Helm 传递文件路径，运行结束删除文件。`upgrade/status/doctor` 不接受初始账号参数。

数据库通过事务锁保证空库只初始化一个管理员；有管理员后，重新启动或升级不会改密码，也不会因初始化用户名变化额外创建账号。当前登录会话存于数据库，升级继续有效。

已安装实例需要修改密码时，使用 API 容器的显式维护命令：

```sh
kubectl -n search exec -i deployment/oas-api -- /app/oas-server reset-admin-password < ./new-password.txt
```

命令从标准输入读取新密码，更新容器配置的 `OAS_ADMIN_USERNAME` 对应账号，并在同一事务中注销其旧会话；不存在的账号报错，不创建新用户。重置前已经验证旧散列的在途登录，也不能在重置后补发会话。维护后应同步 Secret 中的 `admin-password`，保持初始化配置与当前账号一致；只改 Secret 不会重置现有数据库账号。该维护命令不增加公开 HTTP 接口。

### Crawl4AI 的公网域名解析

如果出口 DNS 为公开域名返回 `198.18.0.0/15` 等保留地址，Crawl4AI 的 URL 检查会拒绝该目标。可在安装或升级的 values 中启用 Pod 本地的 DNS over TLS。先用 `kubectl -n kube-system get svc kube-dns` 查询本集群的 DNS Service IP，再填写 `clusterServer`。`clusterDomain` 使用集群实际域名。`upstream` 使用可到达的 IPv4 地址，`tlsServerName` 用于校验证书。

```yaml
crawl4ai:
  enabled: true
  publicDns:
    enabled: true
    image: registry.k8s.io/coredns/coredns:v1.14.2
    clusterServer: "10.96.0.10"
    clusterDomain: cluster.local
    upstream: "1.1.1.1"
    tlsServerName: cloudflare-dns.com
```

该选项默认为关闭。启用时 Crawl4AI Pod 通过本地回环地址解析域名，集群域名与反向查询转至 `clusterServer`，公网查询通过验证证书的 TLS 连接送达 `upstream`。目标 URL 继续经过 Crawl4AI 的地址检查。SearXNG 与 Firefox 各自使用自己的 DNS 配置。

## 服务时区与浏览器容量

Helm 的 `timeZone` 默认为 `Asia/Shanghai`。省略调用方时间时，API 依据这个时区解释相对日期。`browser.replicas` 默认 1，`browser.slots` 默认 6，分别控制浏览器 Pod 数量和每个 Pod 的独立 Firefox 搜索会话数。增加槽位时应相应配置 `browser.resources` 的内存请求与限制。
