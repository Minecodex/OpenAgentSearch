import { ReactNode } from 'react';
import { Button, Card, Chip, Input, Label, Modal, TextField } from '@heroui/react';
import {
  ArrowUpRight,
  BookOpen,
  ChartNoAxesCombined,
  ChevronDown,
  FileText,
  FlaskConical,
  Folder,
  Globe2,
  Layers3,
  LayoutDashboard,
  List,
  Network,
  Search,
  Waypoints,
  X,
} from 'lucide-react';
import { Op, Page, Status, navLabels, opLabels, statusLabels } from './model';
import { useConsole } from './state';
export const pageIcons = {
  overview: LayoutDashboard,
  projects: Folder,
  endpoints: Waypoints,
  proxies: Network,
  languages: Globe2,
  playground: FlaskConical,
  requests: List,
  observability: ChartNoAxesCombined,
  api: BookOpen,
};
export const opIcons = { list: List, content: FileText, summary: Layers3 };
export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span aria-hidden className={'brand-mark ' + (small ? 'small' : '')}>
      <i />
      <i />
      <i />
    </span>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <Mark />
      <strong>OpenAgentSearch</strong>
    </div>
  );
}
type ButtonProps = {
  children?: ReactNode;
  onPress?: () => void;
  primary?: boolean;
  small?: boolean;
  disabled?: boolean;
  className?: string;
  label?: string;
  iconOnly?: boolean;
  type?: 'button' | 'submit';
  test?: string;
};
export function Btn({
  children,
  onPress,
  primary,
  small,
  disabled,
  className = '',
  label,
  iconOnly,
  type = 'button',
  test,
}: ButtonProps) {
  const control = (
    <Button
      type={type}
      onPress={onPress}
      isDisabled={disabled}
      isIconOnly={iconOnly}
      aria-label={label}
      size={small ? 'sm' : 'md'}
      variant={primary ? 'primary' : 'outline'}
      className={
        'ui-btn ' +
        (primary ? 'primary ' : 'neutral ') +
        (small ? 'mini ' : '') +
        (iconOnly ? 'icon-only ' : '') +
        className
      }
      data-testid={test}
    >
      {children}
    </Button>
  );
  return label ? (
    <span className="button-tip" title={label}>
      {control}
    </span>
  ) : (
    control
  );
}
export function IconBtn({
  icon: Icon,
  label,
  onPress,
  test,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  test?: string;
}) {
  return (
    <Btn iconOnly small label={label} onPress={onPress} className="quiet" test={test}>
      <Icon size={17} />
    </Btn>
  );
}
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <Card className={'panel ' + className}>{children}</Card>;
}
export function StateChip({ value }: { value: Status }) {
  const { l } = useConsole();
  return (
    <Chip size="sm" className={'state-chip ' + value}>
      <span className="state-dot" />
      {l(statusLabels[value])}
    </Chip>
  );
}
export function OpLabel({ op }: { op: Op }) {
  const { l } = useConsole();
  const I = opIcons[op];
  return (
    <span className={'op-label op-' + op}>
      <I size={14} />
      {l(opLabels[op])}
    </span>
  );
}
export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </header>
  );
}
export function Caption({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="caption">
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
  test,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (v: string) => void;
  test?: string;
}) {
  return (
    <span className="choice">
      <select
        aria-label={label}
        title={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={test}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={13} />
    </span>
  );
}
export function Field({
  label,
  value,
  change,
  type = 'text',
  placeholder,
  required = false,
  test,
}: {
  label: string;
  value: string;
  change: (s: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  test?: string;
}) {
  return (
    <TextField className="field" value={value} onChange={change} type={type as any} isRequired={required}>
      <Label>{label}</Label>
      <Input placeholder={placeholder} data-testid={test} />
    </TextField>
  );
}
export function SelectField(props: Parameters<typeof Choice>[0]) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <Choice {...props} />
    </label>
  );
}
export function Segments({
  items,
  value,
  change,
  label,
}: {
  items: { id: string; label: string; icon?: any }[];
  value: string;
  change: (id: string) => void;
  label: string;
}) {
  return (
    <div className="segments" role="group" aria-label={label}>
      {items.map(({ id, label, icon: I }) => (
        <Button
          key={id}
          size="sm"
          variant="ghost"
          aria-pressed={id === value}
          onPress={() => change(id)}
          className={value === id ? 'chosen' : ''}
        >
          {I && <I size={15} />}
          <span>{label}</span>
        </Button>
      ))}
    </div>
  );
}
export function SearchBox({
  value,
  change,
  placeholder,
}: {
  value: string;
  change: (s: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-box">
      <Search size={15} />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(e) => change(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button type="button" aria-label={placeholder} onClick={() => change('')}>
          <X size={13} />
        </button>
      )}
    </label>
  );
}
export function Empty({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <Search size={24} />
      <p>{text}</p>
    </div>
  );
}
export function DialogFrame({
  title,
  children,
  wide = false,
  covered = false,
  footer,
  dismiss,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
  covered?: boolean;
  footer?: ReactNode;
  dismiss?: () => void;
}) {
  const { close, t } = useConsole();
  const requestClose = dismiss ?? close;
  return (
    <Modal.Backdrop
      isOpen
      isDismissable
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
      className="oas-backdrop"
    >
      <Modal.Container placement="center" className="oas-container">
        <div className="dialog-surface" aria-hidden={covered || undefined} inert={covered || undefined}>
          <Modal.Dialog
            aria-label={title}
            className={'oas-dialog ' + (wide ? 'wide' : '') + (footer ? ' editor-frame' : '')}
          >
            <header>
              <Modal.Heading>{title}</Modal.Heading>
              <IconBtn icon={X} label={t('关闭', 'Close')} onPress={requestClose} />
            </header>
            <Modal.Body className="dialog-body">{children}</Modal.Body>
            {footer && <div className="editor-footer">{footer}</div>}
          </Modal.Dialog>
        </div>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
export function RangeSelect() {
  const { t, period, setPeriod } = useConsole();
  return (
    <Choice
      value={String(period)}
      label={t('时间范围', 'Time range')}
      options={[1, 7, 30].map((n) => ({ value: '' + n, label: t('近 ' + n + ' 天', 'Last ' + n + ' days') }))}
      onChange={(v) => setPeriod(Number(v))}
      test="range"
    />
  );
}
export function PageLink({ page, text }: { page: Page; text?: string }) {
  const { go, l } = useConsole();
  return (
    <button className="text-link" onClick={() => go(page)}>
      {text || l(navLabels[page])}
      <ArrowUpRight size={14} />
    </button>
  );
}
export function download(name: string, text: string) {
  const href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
export function useCopy() {
  const { notify, t } = useConsole();
  return async (text: string) => {
    try {
      if (!navigator.clipboard) throw Error();
      await navigator.clipboard.writeText(text);
      notify(t('已复制', 'Copied'));
    } catch {
      const a = document.createElement('textarea');
      a.value = text;
      document.body.appendChild(a);
      a.select();
      const ok = document.execCommand('copy');
      a.remove();
      notify(ok ? t('已复制', 'Copied') : t('请选中文字手动复制', 'Select the text to copy it'));
    }
  };
}
export function SourceLink({ url, children }: { url: string; children?: ReactNode }) {
  let href: string | undefined;
  try {
    const target = new URL(url);
    if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password)
      href = target.href;
  } catch {
    /* An unrecognized URL is displayed as text. */
  }
  return href ? (
    <a className="source-url" href={href} target="_blank" rel="noopener noreferrer">
      {children ?? url}
    </a>
  ) : (
    <span className="wrap-code">{url}</span>
  );
}
