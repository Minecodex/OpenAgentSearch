import { Waypoints } from "lucide-react";
import { originName, timestamp, testOutcome } from "./request-display";
import type { Entity } from "./api";
import { useApp } from "./state";
import { Facts, Status, Empty } from "./ui";
export function useDiagnosticLabel() {
  const { t } = useApp();
  const labels: Record<string, [string, string]> = {
    primary: ["项目首池", "Primary pool"],
    fallback: ["后续池", "Fallback pool"],
    language: ["语言命中池", "Language-matched pool"],
    direct: ["直接指定", "Direct"],
    complete: ["已完整评价", "Fully evaluated"],
    incomplete: ["评价不完整", "Incomplete evaluation"],
    unscored: ["尚未评分", "Not scored"],
    no_candidates: ["确知无候选", "Confirmed no candidates"],
    missing: ["未取得结果", "Result not received"],
    received: ["正文调用", "Article call"],
    model: ["模型调用", "Model call"],
    allocate: ["分配资源", "Allocate resources"],
    context: ["创建浏览器上下文", "Create browser context"],
    execute: ["控制调用（含通信）", "Control call (including transport)"],
    validate: ["校验访问目标", "Validate destination"],
    navigate: ["页面加载", "Page navigation"],
    extract: ["提取内容", "Content extraction"],
    archive: ["归档页面与资源", "Archive page and assets"],
    cleanup: ["回收上下文", "Context cleanup"],
    connect: ["建立连接", "Establish connection"],
    handshake: ["代理及 TLS 握手", "Proxy and TLS handshake"],
    response: ["目标响应与校验", "Target response and validation"],
    proxy_auth: ["代理认证失败", "Proxy authentication failed"],
    proxy_tls: ["代理证书校验失败", "Proxy certificate verification failed"],
    proxy_refused: ["代理拒绝建立通道", "Proxy refused the tunnel"],
    proxy_dns: ["代理域名解析失败", "Proxy DNS lookup failed"],
    proxy_connect: ["代理连接失败", "Proxy connection failed"],
    proxy_protocol: ["代理协议失败", "Proxy protocol failed"],
    target_connect: ["目标连接失败", "Target connection failed"],
    target_dns: ["目标域名解析失败", "Target DNS lookup failed"],
    target_tls: ["目标证书校验失败", "Target certificate verification failed"],
    timeout: ["检测超时", "Probe timed out"],
    target_response: ["目标状态与预期不符", "Unexpected target status"],
    target_body: ["目标内容与预期不符", "Unexpected target content"],
    body_limit: ["响应超出采集上限", "Response exceeded the capture limit"],
    response_incomplete: [
      "目标响应未完整取得",
      "Target response was incomplete",
    ],
  };
  return (value: string) => (labels[value] ? t(...labels[value]) : value);
}
export function Phases({
  phases,
  probe = false,
}: {
  phases: Entity[];
  probe?: boolean;
}) {
  const { t } = useApp();
  const label = useDiagnosticLabel();
  if (!phases?.length)
    return (
      <Empty>{t("未记录阶段诊断", "No phase diagnostics recorded")}</Empty>
    );
  return (
    <section
      className="phase-diagnostics"
      aria-label={
        probe
          ? t("代理检测阶段", "Proxy test phases")
          : t("浏览器执行阶段", "Browser execution phases")
      }
    >
      <p className="muted">
        {probe
          ? t(
              "连接、握手与目标响应分别计时；未开始的阶段不计为零耗时。",
              "Connection, handshake and target response are timed separately; stages that did not start are not zero-duration samples.",
            )
          : t(
              "资源与上下文属于作业阶段；控制调用是父阶段，工作端子阶段不与其相加。子阶段偏移以控制调用开始对齐，包含单程通信误差。",
              "Allocation and context belong to the job. The control call is a parent; worker stages are not added to it. Child offsets align to the control call and include one-way transport uncertainty.",
            )}
      </p>
      <ol className="phase-list">
        {phases.map((phase, index) => (
          <li
            key={index}
            data-phase={phase.stage}
            data-parent={phase.parent_stage || ""}
            className={phase.parent_stage ? "phase-child" : ""}
          >
            <div>
              <strong>{label(phase.stage)}</strong>
              <small>
                {phase.scope === "job"
                  ? t("浏览器作业", "Browser job")
                  : t("本次调用", "This call")}{" "}
                ·{" "}
                {phase.source === "worker"
                  ? t("执行器计时", "Worker clock")
                  : t("后端计时", "API clock")}
              </small>
            </div>
            <span>
              {phase.start_offset_ms} ms →{" "}
              {phase.start_offset_ms + phase.duration_ms} ms
            </span>
            <b>{phase.duration_ms} ms</b>
            <Status value={phase.status} />
          </li>
        ))}
      </ol>
    </section>
  );
}
export function BrowserDetails({ job }: { job: Entity }) {
  const { t, resources, language } = useApp();
  const source =
    job.egress_mode === "proxy"
      ? `${job.pool_name || t("自动选择", "Automatic")} / ${job.proxy_name || t("代理", "Proxy")}`
      : t("Pod 默认网络", "Pod default network");
  return (
    <section className="browser-details">
      <h3>{t("浏览器与出口", "Browser and egress")}</h3>
      <Facts
        items={[
          [t("实际执行实例", "Executing Pod"), job.pod_name],
          [t("实例 UID", "Pod UID"), job.pod_uid],
          [t("作业 ID", "Job ID"), job.job_id],
          [t("本次出口", "Selected egress"), source],
          [
            t("代理协议", "Proxy protocol"),
            job.scheme?.toUpperCase() || t("默认网络", "Default network"),
          ],
          [
            t("上下文使用方式", "Context use"),
            job.reused_context
              ? t(
                  "复用本请求已创建的上下文",
                  "Reused the context of this request",
                )
              : t("本次创建", "Created for this call"),
          ],
          ...(job.search_engine
            ? ([
                [
                  t("实际搜索引擎", "Selected search engine"),
                  job.search_engine === "google"
                    ? "Google"
                    : t("百度", "Baidu"),
                ],
                [
                  t("Google 连通性", "Google reachability"),
                  job.google_probe?.reachable
                    ? t("可达", "Reachable")
                    : t("已测不可达", "Measured unreachable"),
                ],
                [
                  t("样本完成时间", "Probe completion"),
                  job.google_probe?.checked_at || "—",
                ],
                [
                  t("采样实例 UID", "Probe Pod UID"),
                  job.google_probe?.probe_pod_uid || "—",
                ],
              ] as [string, string][])
            : []),
        ]}
      />
      {job.engine_selection && (
        <p className="notice">{t("此出口的 Google 搜索暂时不可用，直接使用百度。重试时间", "Google search is temporarily unavailable on this egress. Using Baidu until")}
          {" "}{timestamp(job.engine_selection.retry_at, language)}
        </p>
      )}
      {job.engine_fallback && (
        <p className="notice">
          Google → {t("百度", "Baidu")} ·{" "}
          {testOutcome(job.engine_fallback.reason, t)}
        </p>
      )}
      <Phases phases={job.phases || []} />
    </section>
  );
}
export function CallFacts({ call }: { call: Entity }) {
  const { t, resourceName, language } = useApp(),
    label = useDiagnosticLabel(),
    total = call.execution_ms + call.queue_ms;
  return (
    <>
      <div className="sheet-identity">
        <span className="tile-icon">
          <Waypoints size={20} />
        </span>
        <div>
          <strong>{resourceName(call)}</strong>
          <small className="row-sub mono">{call.call_id}</small>
        </div>
        <Status value={call.status} />
      </div>
      <div className="sheet-query">
        <small>{t("输入", "Input")}</small>
        <p>{call.input_preview || t("未记录输入", "Input not recorded")}</p>
      </div>
      <Facts
        items={[
          [t("来源", "Origin"), originName(call.origin, t)],
          [t("调度原因", "Routing reason"), label(call.reason || "—")],
          [t("调用开始", "Started"), timestamp(call.started_at, language)],
          [t("业务语言", "Business language"), call.language],
          [
            t("已发送", "Dispatched"),
            call.sent ? t("是", "Yes") : t("否", "No"),
          ],
          [t("结果原因", "Result reason"), call.error_code || "—"],
        ]}
      />
      <h3>{t("耗时分解", "Timing breakdown")}</h3>
      <div className="call-timing" aria-hidden="true">
        <i
          style={{
            width: (total > 0 ? (100 * call.queue_ms) / total : 0) + "%",
          }}
        />
      </div>
      <Facts
        items={[
          [t("排队耗时", "Queue duration"), call.queue_ms + " ms"],
          [t("执行耗时", "Execution duration"), call.execution_ms + " ms"],
        ]}
      />
      <h3>{t("结果与评价", "Results and evaluation")}</h3>
      <Facts
        items={[
          [t("评价状态", "Evaluation"), label(call.evaluation || "—")],
          [
            t("相关 / 已评价候选", "Relevant / evaluated candidates"),
            (call.relevant ?? "—") + " / " + (call.evaluated ?? "—"),
          ],
          [
            t("输入 / 输出 Token", "Input / output tokens"),
            (call.input_tokens ?? "—") + " / " + (call.output_tokens ?? "—"),
          ],
        ]}
      />
      {call.browser_job && <BrowserDetails job={call.browser_job} />}
    </>
  );
}
export function ProbeDetails({ value }: { value: Entity }) {
  const { t } = useApp();
  const label = useDiagnosticLabel();
  return (
    <section className="probe-details">
      <h3>{t("代理检测诊断", "Proxy test diagnostics")}</h3>
      <Facts
        items={[
          [
            t("网络通道可达", "Network reachable"),
            value.reachable ? t("是", "Yes") : t("否", "No"),
          ],
          [
            t("符合预期响应", "Expected response matched"),
            value.passed ? t("是", "Yes") : t("否", "No"),
          ],
          [
            t("目标 HTTP 状态", "Target HTTP status"),
            value.http_status ?? t("未收到目标响应", "No target response"),
          ],
          [t("预期 HTTP 状态", "Expected HTTP status"), value.expected_status],
          [
            t("内容标记匹配", "Content marker matched"),
            value.body_matches == null
              ? t("未配置", "Not configured")
              : value.body_matches
                ? t("是", "Yes")
                : t("否", "No"),
          ],
          [
            t("代理自身通道", "Proxy transport"),
            value.proxy_healthy == null
              ? t("未知", "Unknown")
              : value.proxy_healthy
                ? t("已确认可用", "Confirmed available")
                : t("已确认失败", "Confirmed failed"),
          ],
          [
            t("原因", "Reason"),
            value.failure_kind
              ? label(value.failure_kind)
              : t("符合预期", "Matched expectations"),
          ],
          [
            t("首字节时间", "Time to first byte"),
            value.first_byte_ms == null ? "—" : `${value.first_byte_ms} ms`,
          ],
          [t("总耗时", "Total duration"), `${value.total_ms} ms`],
        ]}
      />
      <Phases phases={value.phases || []} probe />
    </section>
  );
}

export function SearchAttempts({
  attempts,
}: {
  attempts: Entity[] | undefined;
}) {
  const { t } = useApp();
  if (!attempts?.length) return null;
  return (
    <ol
      className="engine-attempts"
      aria-label={t("搜索引擎尝试", "Search engine attempts")}
    >
      {attempts.map((a) => (
        <li key={a.call_id}>
          <b>{a.engine === "google" ? "Google" : t("百度", "Baidu")}</b>
          <Status value={a.status} />
          {a.reason && <small>{testOutcome(a.reason, t)}</small>}
        </li>
      ))}
    </ol>
  );
}
