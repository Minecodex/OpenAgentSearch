import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, write, ApiError, type Entity } from "./api";
import { useApp } from "./state";
import { Btn, Dialog, Field, Facts, Notice, Empty } from "./ui";
import { HotPolicyFields } from "./cache-policy";

export function CacheSettings({ section, close }: { section: "concurrency" | "policy" | "model-budgets"; close: () => void }) {
  const { t } = useApp();
  const client = useQueryClient();
  const endpoint = "/admin/v1/settings/cache-" + section;
  const current = useQuery({ queryKey: ["cache-settings", section], queryFn: () => api<Entity>(endpoint) });
  const [draft, setDraft] = useState<Entity | null>(null);
  const value = draft || current.data;
  const save = useMutation({ mutationFn: async () => {
    if (!value || !current.data) return;
    const body = section === "concurrency" ? { configured_limit: value.configured_limit }
      : section === "model-budgets" ? { concurrency: value.concurrency, rpm: value.rpm } : { list: value.list, content: value.content };
    return write(endpoint, { ...body, expected_version: value.version }, "PUT");
  }, onSuccess: result => {
    client.setQueryData(["cache-settings", section], result);
    void client.invalidateQueries({ queryKey: ["cache-overview"] });
    close();
  } });
  const title = section === "concurrency" ? t("调整后台浏览器并发", "Background browser concurrency")
    : section === "policy" ? t("系统缓存热点策略", "Default cache hotness policy") : t("后台模型预算", "Background model budget");
  const tabs = Number(current.data?.ready_tabs || 0);
  return <Dialog title={title} close={close} dirty={!!draft} save={value ? () => save.mutate() : undefined}
    busy={save.isPending || (section === "concurrency" && tabs < 2)}>
    <Notice error={current.error || save.error} />
    {current.isPending && <Empty>{t("正在读取设置…", "Loading settings…")}</Empty>}
    {value && <>
      {section === "concurrency" ? <>
        <p>{t("所有项目共享此上限。下调时在途作业自然完成，未确认清理仍占用真实名额。", "This global limit is shared by all projects. In-flight jobs finish naturally and retain capacity until cleanup is confirmed.")}</p>
        <Facts items={[[t("已保存上限", "Saved limit"), current.data?.configured_limit], [t("实际生效", "Effective limit"), current.data?.effective_limit],
          [t("就绪标签", "Ready tabs"), tabs], [t("后台占用", "Background occupied"), current.data?.background_active]]} />
        <Field label={t("后台并发数", "Background concurrency")} type="number" step={1} value={value.configured_limit}
          disabled={tabs < 2} change={v => setDraft({ ...value, configured_limit: Number(v) })}
          hint={tabs < 2 ? t("标签容量不足，保留已保存值。", "Insufficient tab capacity. The saved value is retained.") : t(`允许范围 1–${tabs - 1}。`, `Allowed range 1–${tabs - 1}.`)} />
      </> : section === "policy" ? <>{["list", "content"].map(kind => <HotPolicyFields key={kind} inherit={false}
        title={kind === "list" ? t("列表缓存", "Search lists") : t("正文缓存", "Page content")} value={value[kind]}
        change={policy => setDraft({ ...value, [kind]: policy })} />)}</> : <>
        <p>{t("每个生成模型端点分别应用。与前台共享总额度，前台等待时暂停派发新的后台调用。", "Applied separately to each generation endpoint. Total capacity is shared and new background calls yield to waiting foreground work.")}</p>
        <Field type="number" label={t("每端点后台并发", "Background concurrency per endpoint")} value={value.concurrency} change={v => setDraft({ ...value, concurrency: Number(v) })} />
        <Field type="number" label={t("每端点后台每分钟上限", "Background requests per minute per endpoint")} value={value.rpm} change={v => setDraft({ ...value, rpm: Number(v) })} />
      </>}
    </>}
    {save.error instanceof ApiError && save.error.status === 409 && <Btn onPress={() => { setDraft(null); save.reset(); void current.refetch(); }}>{t("重读最新配置", "Reload latest settings")}</Btn>}
  </Dialog>;
}
