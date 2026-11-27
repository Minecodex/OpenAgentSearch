import { Field, Select, Facts } from "./ui";
import { useApp } from "./state";
import type { Entity } from "./api";

export const defaultHotPolicy = { total_hot_percent: 10, recent_hot_percent: 10, recent_window_hours: 24 };
export function HotPolicyFields({ title, value, defaults = defaultHotPolicy, change, disabled = false, inherit = true }: {
  title: string; value?: Entity | null; defaults?: Entity; change: (value: Entity | null) => void; disabled?: boolean; inherit?: boolean;
}) {
  const { t } = useApp();
  const effective = value || defaults;
  return <section className="config-section">
    <h3 className="form-section">{title}</h3>
    {inherit && <Select label={t("策略来源", "Policy source")} value={value ? "custom" : "inherit"} disabled={disabled}
      change={v => change(v === "inherit" ? null : { ...defaults })}
      options={[{ value: "inherit", label: t("继承系统默认", "Use system defaults") }, { value: "custom", label: t("自定义", "Custom") }]} />}
    {(value || !inherit) ? <div className="form-grid">{[
      ["total_hot_percent", t("累计热点比例（%）", "All-time hot share (%)")],
      ["recent_hot_percent", t("近期热点比例（%）", "Recent hot share (%)")],
      ["recent_window_hours", t("近期窗口（小时）", "Recent window (hours)")],
    ].map(([key, label]) => <Field key={key} label={label} type="number" step={1} disabled={disabled}
      value={effective[key]} change={v => change({ ...effective, [key]: Number(v) })}
      hint={key.endsWith("percent") ? t("范围 1–100，输入 0 按 1% 保存。", "Use 1–100. Zero is saved as 1%.") : undefined} />)}</div>
      : <Facts items={[[t("累计热点", "All-time"), `${effective.total_hot_percent}%`], [t("近期热点", "Recent"), `${effective.recent_hot_percent}%`], [t("近期窗口", "Window"), `${effective.recent_window_hours}h`]]} />}
    {disabled && <p className="field-help">{t("开启缓存后生效。", "Takes effect when caching is enabled.")}</p>}
  </section>;
}
