import { OverflowText } from "./overflow-text";
import { Network } from "lucide-react";
import { Link } from "react-router-dom";
import { useApp } from "./state";
import type { Entity } from "./api";
import { Btn, DataTable, Status, Panel } from "./ui";
import { timestamp } from "./request-display";
import { GoogleReachability } from "./google-reachability";

export function ResourceInventory({
  kind,
  rows,
  show,
  edit,
  test,
  testing,
  cancel,
}: {
  kind: string;
  rows: Entity[];
  show: (row: Entity) => void;
  edit: (row: Entity) => void;
  test: (id: string) => void;
  testing: string;
  cancel: () => void;
}) {
  const { t, language, resources, name } = useApp();
  const endpoint = kind === "endpoints",
    pool = kind === "proxy-pools";
  if (pool)
    return (
      <div className="pool-inventory">
        {rows.map((pool) => {
          const projects = (resources.data?.projects || []).filter(
            (p) => p.browser_proxy_pool_id === pool.id,
          );
          return (
            <Panel key={pool.id} className="pool-card">
              <span className="tile-icon">
                <Network size={21} />
              </span>
              <h2>
                <button className="row-link resource-name" onClick={() => show(pool)}>
                  <OverflowText>{pool.name}</OverflowText>
                </button>
              </h2>
              <dl className="field-map">
                {pool.members.map((m: Entity) => (
                  <div key={m.proxy_id}>
                    <dt>{name(m.proxy_id)}</dt>
                    <dd>
                      {t("权重", "Weight")} {m.weight}
                    </dd>
                  </div>
                ))}
              </dl>
              {projects.length > 0 && (
                <small className="muted">
                  {t("引用项目", "Bound projects")} ·{" "}
                  {projects.map((p) => p.name).join(" · ")}
                </small>
              )}
              <footer>
                <Btn small onPress={() => edit(pool)}>
                  {t("编辑成员", "Edit members")}
                </Btn>
              </footer>
            </Panel>
          );
        })}
      </div>
    );
  const columns = endpoint
    ? [
        t("接入点 / 服务商", "Endpoint / provider"),
        t("凭据", "Credentials"),
        t("超时", "Timeout"),
        t("并发 / 每分钟上限", "Concurrency / RPM"),
        t("状态", "Availability"),
        t("本版本测试", "Version test"),
      ]
    : [
        t("代理 / 地址", "Proxy / address"),
        t("认证", "Authentication"),
        t("活跃 / 容量", "Active / capacity"),
        t("网络状态", "Network health"),
        t("Google 连通性", "Google reachability"),
        t("本版本测试", "Version test"),
      ];
  return (
    <DataTable>
      <DataTable.Header>
        {[...columns, t("操作", "Actions")].map((col) => (
          <DataTable.Column key={col}>{col}</DataTable.Column>
        ))}
      </DataTable.Header>
      <DataTable.Body>
        {rows.map((e) => {
          const last =
            e.last_test?.resource_version === e.version ? e.last_test : null;
          const testCell = (
            <DataTable.Cell>
              {last ? (
                <Link
                  className="text-link"
                  to={"/requests/" + last.trace_request_id}
                >
                  <Status value={last.status} />
                  <small className="row-sub">{last.elapsed_ms} ms ↗</small>
                </Link>
              ) : (
                t("尚未测试", "Untested")
              )}
            </DataTable.Cell>
          );
          return (
            <DataTable.Row key={e.id}>
              <DataTable.Cell>
                <button className="row-link resource-name" onClick={() => show(e)}>
                  <OverflowText>{e.name}</OverflowText>
                </button>
                <small className="row-sub">
                  {[
                    e.provider || e.scheme,
                    "v" + e.version,
                    e.managed_by === "system" ? t("内置", "Built-in") : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                {(e.base_url || e.host) && (
                  <small className="row-sub">
                    <OverflowText>{e.base_url || e.host + ":" + e.port}</OverflowText>
                  </small>
                )}
              </DataTable.Cell>
              <DataTable.Cell>
                {e.has_secret
                  ? t("已配置", "Configured")
                  : e.managed_by === "system" ||
                      e.managed_by === "helm" ||
                      e.auth_mode === "none"
                    ? t("无需凭据", "Not required")
                    : t("未配置", "Unconfigured")}
              </DataTable.Cell>
              {endpoint ? (
                <DataTable.Cell>{e.timeout_ms / 1000} s</DataTable.Cell>
              ) : (
                <DataTable.Cell>
                  {e.active_leases} / {e.max_concurrency}
                </DataTable.Cell>
              )}
              {endpoint && (
                <DataTable.Cell>
                  {e.max_concurrency} / {e.rpm}
                </DataTable.Cell>
              )}
              <DataTable.Cell>
                <div className="availability-line">
                <Status
                  value={
                    endpoint
                      ? e.availability
                      : e.enabled
                        ? e.health
                        : "disabled"
                  }
                />
                {endpoint && e.provider === "browser" && e.kind === "search" && (
                  <GoogleReachability probe={e.default_network_google_probe} />
                )}
                </div>
                {e.ready_pods != null && (
                  <small className="row-sub">{e.ready_pods} {t("个实例", "Pods")}</small>
                )}
              </DataTable.Cell>
              {!endpoint && (
                <DataTable.Cell>
                  {e.google_probe?.reachable == null
                    ? t("待首次检测", "Awaiting first probe")
                    : e.google_probe.reachable
                      ? t("可达", "Reachable")
                      : t("不可达", "Unreachable")}
                  {e.google_probe?.checked_at && (
                    <small className="row-sub">
                      {timestamp(e.google_probe.checked_at, language)}
                    </small>
                  )}
                </DataTable.Cell>
              )}
              {testCell}
              <DataTable.Cell>
                <div className="table-actions">
                  <Btn small onPress={() => show(e)}>
                    {t("详情", "Details")}
                  </Btn>
                  {!["system", "helm"].includes(e.managed_by) && (
                    <Btn small onPress={() => edit(e)}>
                      {t("编辑", "Edit")}
                    </Btn>
                  )}
                  {testing === e.id ? (
                    <Btn small onPress={cancel}>
                      {t("取消测试", "Cancel test")}
                    </Btn>
                  ) : (
                    <Btn small disabled={!!testing} onPress={() => test(e.id)}>
                      {t("测试", "Test")}
                    </Btn>
                  )}
                </div>
              </DataTable.Cell>
            </DataTable.Row>
          );
        })}
      </DataTable.Body>
    </DataTable>
  );
}
