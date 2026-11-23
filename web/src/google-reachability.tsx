import { Tooltip } from "@heroui/react";
import { CircleAlert } from "lucide-react";
import type { Entity } from "./api";
import { timestamp } from "./request-display";
import { useApp } from "./state";
import "./probe-indicator.css";

export function GoogleReachability({ probe }: { probe?: Entity | null }) {
  const { t, language } = useApp();
  const state = probe?.reachable == null ? "pending" : probe.reachable ? "reachable" : "unreachable";
  const label = state === "pending"
    ? t("Google 待首次检测", "Google awaiting first probe")
    : state === "reachable"
      ? t("Google 网络可达", "Google network reachable")
      : t("Google 网络不可达", "Google network unreachable");
  return (
    <Tooltip delay={0}>
      <Tooltip.Trigger className={"probe-indicator " + state} aria-label={label}>
        <CircleAlert size={17} aria-hidden="true" />
      </Tooltip.Trigger>
      <Tooltip.Content className="probe-tooltip">
        <strong>{label}</strong>
        <p>{t("Pod 默认网络的缓存检测结果", "Cached probe for the default Pod network")}</p>
        {probe?.checked_at && <p>{t("最近检测", "Last checked")}：{timestamp(probe.checked_at, language)}</p>}
        <p>{state === "pending"
          ? t("等待后台首次检测；业务搜索不会触发重新检测。", "Waiting for the background probe; searches do not trigger a new probe.")
          : state === "reachable"
            ? t("优先 Google；搜索风控或失败后切换百度，冷却期间直接使用百度。网络可达不代表搜索页未被风控。", "Prefer Google; switch to Baidu on search restrictions or failures and during cooldown. Network reachability does not guarantee an unrestricted search page.")
            : t("直接使用百度。后台每 30 分钟重新检测。", "Use Baidu directly. The background probe runs every 30 minutes.")}</p>
        <p>{t("绑定代理池的项目使用所选代理的独立检测结果。", "Projects with a proxy pool use the selected proxy's own probe.")}</p>
      </Tooltip.Content>
    </Tooltip>
  );
}
