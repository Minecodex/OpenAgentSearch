import { OverflowText } from "./overflow-text";
import {
  type ReactNode,
  type ReactElement,
  type HTMLInputAutoCompleteAttribute,
  Children,
  cloneElement,
  isValidElement,
  useState,
} from "react";
import {
  Button,
  Card,
  Chip,
  TextField,
  TextArea,
  Label,
  Input,
  Modal,
  AlertDialog,
  Drawer,
  Select as HeroSelect,
  ListBox,
  Table,
  Tabs,
  Description,
} from "@heroui/react";
import { Check, X } from "lucide-react";
import { ApiError } from "./api";
import { useApp } from "./state";
export function Btn({
  children,
  onPress,
  primary,
  disabled = false,
  small = false,
  type = "button",
  test,
  "aria-label": ariaLabel,
  "aria-expanded": expanded,
  className = "",
  iconOnly = false,
  pending = false,
  size,
  danger = false,
  autoFocus = false,
}: {
  children?: ReactNode;
  onPress?: () => void;
  primary?: boolean;
  disabled?: boolean;
  small?: boolean;
  type?: "button" | "submit";
  test?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  className?: string;
  iconOnly?: boolean;
  pending?: boolean;
  size?: "sm" | "md" | "lg";
  danger?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <Button
      type={type}
      onPress={onPress}
      isDisabled={disabled}
      isIconOnly={iconOnly}
      isPending={pending}
      autoFocus={autoFocus}
      variant={danger ? "danger" : primary ? "primary" : "outline"}
      size={size || (small ? "sm" : "md")}
      className={
        "ui-btn oas-button " +
        (danger ? "destructive" : primary ? "primary" : "neutral") +
        (small ? " mini" : "") +
        (iconOnly ? " icon-only" : "") +
        " " +
        className
      }
      data-testid={test}
      aria-label={ariaLabel}
      aria-expanded={expanded}
    >
      {children}
    </Button>
  );
}
export function Field({
  label,
  value,
  change,
  type = "text",
  required = false,
  hint,
  step,
  autoComplete,
  placeholder,
  multiline = false,
}: {
  label: string;
  value: string | number;
  change: (v: string) => void;
  type?: string;
  required?: boolean;
  hint?: string;
  step?: number;
  autoComplete?: HTMLInputAutoCompleteAttribute;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <TextField className="field" isRequired={required}>
      <Label>{label}</Label>
      {multiline ? (
        <TextArea
          className="query-input"
          value={String(value)}
          onChange={(event) => change(event.target.value)}
          placeholder={placeholder}
          rows={3}
        />
      ) : (
        <Input
          type={type}
          step={step}
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(e) => change(e.target.value)}
        />
      )}
      {hint && <Description className="field-help">{hint}</Description>}
    </TextField>
  );
}
export function Select({
  label,
  value,
  change,
  options,
}: {
  label: string;
  value: string;
  change: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <HeroSelect
      className="field oas-select"
      value={"item:" + value}
      onChange={(key) => change(String(key || "item:").slice(5))}
    >
      <Label>{label}</Label>
      <HeroSelect.Trigger>
        <HeroSelect.Value />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover className="oas-select-popover">
        <ListBox>
          {options.map((o) => (
            <ListBox.Item
              key={o.value}
              id={"item:" + o.value}
              textValue={o.label}
            >
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );
}
function DataTableRoot({ children }: { children: ReactNode }) {
  const { t } = useApp();
  return (
    <Table variant="secondary" className="oas-table">
      <Table.ScrollContainer>
        <Table.Content
          className="data-table"
          aria-label={t("数据列表", "Data list")}
        >
          {children}
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
function DataHeader({ children }: { children: ReactNode }) {
  return (
    <Table.Header>
      {Children.toArray(children)
        .filter(isValidElement)
        .map((column, index) =>
          cloneElement(column as ReactElement<{ isRowHeader?: boolean }>, {
            isRowHeader: index === 0,
          }),
        )}
    </Table.Header>
  );
}
export const DataTable = Object.assign(DataTableRoot, {
  Header: DataHeader,
  Column: Table.Column,
  Body: Table.Body,
  Row: Table.Row,
  Cell: Table.Cell,
});
export function Segments({
  label,
  items,
  value,
  change,
}: {
  label: string;
  items: [string, string][];
  value: string;
  change: (value: string) => void;
}) {
  return (
    <div className="segments" role="group" aria-label={label}>
      {items.map(([id, text]) => (
        <Button
          key={id}
          variant="ghost"
          size="sm"
          aria-pressed={value === id}
          data-active={value === id}
          onPress={() => change(id)}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}
export function ViewTabs({
  items,
  value,
  change,
  children,
  label,
  toolbar,
  heading,
}: {
  items: [string, ReactNode][];
  toolbar?: ReactNode;
  heading?: ReactNode;
  value: string;
  change: (value: string) => void;
  children: ReactNode;
  label: string;
}) {
  return (
    <Tabs
      selectedKey={value}
      onSelectionChange={(key) => change(String(key))}
      className="view-tabs"
      variant="primary"
    >
      <div className="tabs-tools">
        {heading}
        <Tabs.ListContainer>
          <Tabs.List aria-label={label}>
            {items.map(([id, text]) => (
              <Tabs.Tab id={id} key={id}>
                {text}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
        {toolbar}
      </div>
      <Tabs.Panel id={value}>{children}</Tabs.Panel>
    </Tabs>
  );
}
export const Panel = ({
  children,
  className = "",
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) => (
  <Card className={"panel oas-panel " + className}>
    <Card.Content
      className="oas-panel__body"
      data-padding={flush ? "none" : "default"}
    >
      {children}
    </Card.Content>
  </Card>
);
export const Head = ({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: ReactNode;
}) => (
  <div className="page-head">
    <div>
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
    <div className="head-actions">{children}</div>
  </div>
);
export function Notice({ error }: { error?: unknown }) {
  const { t } = useApp();
  const details = error instanceof ApiError ? error.details : undefined;
  return error ? (
    <p className="form-error" role="alert">
      {error instanceof Error ? error.message : String(error)}
      {details?.field && (
        <>
          {" "}
          · {t("字段", "Field")}: {details.field}
        </>
      )}
      {details?.limit != null && (
        <>
          {" "}
          · {t("上限", "Limit")}: {details.limit}
        </>
      )}
    </p>
  ) : null;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
export function Status({ value }: { value: string }) {
  const { t } = useApp();
  const names: Record<string, [string, string]> = {
    running: ["运行中", "Running"],
    success: ["成功", "Success"],
    partial: ["部分完成", "Partial"],
    error: ["失败", "Failed"],
    empty: ["无结果", "Empty"],
    cancelled: ["已取消", "Cancelled"],
    available: ["可用", "Available"],
    no_ready_pods: ["暂无就绪实例", "No ready instances"],
    component_disabled: ["未安装", "Disabled"],
    component_unready: ["组件未就绪", "Component unready"],
    unknown: ["待检测", "Not checked"],
    healthy: ["健康", "Healthy"],
    cooling: ["冷却中", "Cooling"],
    probing: ["恢复检测中", "Recovery probe"],
    disabled: ["已停用", "Disabled"],
    degraded: ["连接异常", "Connection degraded"],
  };
  const n = names[value];
  return (
    <Chip className={"state-chip " + value} size="sm">
      <i className="state-dot" aria-hidden="true" />
      {n ? t(...n) : value}
    </Chip>
  );
}
export function Dialog({
  title,
  children,
  close,
  dirty = false,
  save,
  busy = false,
  layout = "standard",
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  dirty?: boolean;
  save?: () => void;
  busy?: boolean;
  layout?: "standard" | "wide";
}) {
  const { t } = useApp();
  const [discard, setDiscard] = useState(false);
  const dismiss = () => (dirty ? setDiscard(true) : close());
  return (
    <>
      <Modal.Backdrop
        isOpen
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
        className="atlas-modal-layer"
        data-layout={layout}
      >
        <Modal.Container placement="center" className="atlas-modal-container">
          <Modal.Dialog className="oas-dialog" aria-label={title}>
            <header className="dialog-head">
              <h2>{title}</h2>
              <Button
                isIconOnly
                variant="ghost"
                aria-label={t("关闭", "Close")}
                onPress={dismiss}
              >
                <X size={18} />
              </Button>
            </header>
            <div className="dialog-body">{children}</div>
            <footer className="form-actions">
              <Btn onPress={dismiss}>{t("关闭", "Close")}</Btn>
              {save && (
                <Btn primary onPress={save} disabled={busy}>
                  <Check size={16} aria-hidden="true" />
                  {t("保存", "Save")}
                </Btn>
              )}
            </footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
      {discard && (
        <Confirm
          title={t("放弃未保存的修改？", "Discard unsaved changes?")}
          close={() => setDiscard(false)}
          confirm={close}
          cancelLabel={t("继续编辑", "Keep editing")}
          confirmLabel={t("放弃修改", "Discard")}
        >
          {t("当前草稿将被清除。", "The current draft will be cleared.")}
        </Confirm>
      )}
    </>
  );
}
export function Facts({ items, compact=false }: { items: [string, ReactNode][]; compact?: boolean }) {
  return (
    <dl className="facts-grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            {compact && typeof value === "string" ? <OverflowText>{value}</OverflowText> : value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function Sheet({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const { t } = useApp();
  return (
    <Drawer.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      className="oas-backdrop inspect-backdrop"
    >
      <Drawer.Content placement="right" className="inspect-container">
        <Drawer.Dialog className="inspect-sheet" aria-label={title}>
          <Drawer.Header className="dialog-head inspect-head">
            <Drawer.Heading>{title}</Drawer.Heading>
            <Button
              isIconOnly
              variant="ghost"
              onPress={close}
              aria-label={t("关闭", "Close")}
            >
              <X size={18} />
            </Button>
          </Drawer.Header>
          <Drawer.Body className="inspect-body">{children}</Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
export function Confirm({
  title,
  children,
  close,
  confirm,
  busy = false,
  cancelLabel,
  confirmLabel,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  confirm: () => void;
  busy?: boolean;
  cancelLabel?: string;
  confirmLabel?: string;
}) {
  const { t } = useApp();
  return (
    <AlertDialog.Backdrop
      isOpen
      isDismissable={false}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      className="atlas-modal-layer"
      data-layout="confirm"
    >
      <AlertDialog.Container
        placement="center"
        className="atlas-modal-container"
      >
        <AlertDialog.Dialog className="oas-dialog discard-dialog">
          <AlertDialog.Header>
            <AlertDialog.Heading>{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>{children}</AlertDialog.Body>
          <AlertDialog.Footer>
            <Btn autoFocus onPress={close}>
              {cancelLabel ?? t("取消", "Cancel")}
            </Btn>
            <Btn danger disabled={busy} onPress={confirm}>
              {confirmLabel ?? t("确认", "Confirm")}
            </Btn>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
