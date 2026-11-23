import type { ReactNode } from "react";
import { Tabs } from "@heroui/react";
import { useApp } from "./state";
import { Status } from "./ui";

export type ExecutionItem = {
  id: string;
  title: string;
  status: string;
  duration: number;
};

export function ExecutionTabs({items, value, change, children, label, kind = "attempt"}: {
  items: ExecutionItem[];
  value: string;
  change: (value: string) => void;
  children: ReactNode;
  label?: string;
  kind?: "attempt" | "page";
}) {
  const { t } = useApp();
  return (
    <Tabs selectedKey={value} onSelectionChange={key => change(String(key))}
      className="execution-tabs" variant="secondary">
      <Tabs.ListContainer className="execution-tab-container">
        <Tabs.List className="execution-tab-list" aria-label={label || t("本阶段的执行", "Stage executions")}>
          {items.map((item, index) => (
            <Tabs.Tab className="execution-tab" key={item.id} id={item.id} data-status={item.status}
              aria-label={(kind === "page" ? t("网页 ", "Page ") + (index + 1) : t("第", "Attempt ") + (index + 1) + t("次", "")) + " " + item.title}>
              <span className="execution-tab-content">
                <span className="execution-tab-number">{kind === "page" ? t("网页 ", "Page ") + (index + 1) : t("第", "Attempt ") + (index + 1) + t("次", "")}</span>
                <span className="execution-tab-title" title={item.title}>{item.title}</span>
                <span className="execution-tab-meta">
                  <Status value={item.status}/>
                  <span>{item.duration} {t("毫秒", "ms")}</span>
                </span>
              </span>
              <Tabs.Indicator/>
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
      <Tabs.Panel id={value}>{children}</Tabs.Panel>
    </Tabs>
  );
}
