import { useState, type ReactNode } from 'react';
import { Drawer } from '@heroui/react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useConsole } from './state';
import { Btn, Choice, IconBtn } from './ui';
import { localInput, parseLocal, Window } from './investigation';
import { digits } from './model';
export type Changes = Record<string, string | null>;
export type Pick = { value: string; label: string };
export function Facet({
  name,
  value,
  set,
  options,
  test,
}: {
  name: string;
  value: string;
  set: (v: string) => void;
  options: Pick[];
  test?: string;
}) {
  return (
    <label className="diag-facet">
      <span>{name}</span>
      <Choice label={name} value={value} onChange={set} options={options} test={test} />
    </label>
  );
}
export function WindowPicker({
  params,
  window: w,
  zone,
  hours,
  apply,
}: {
  params: URLSearchParams;
  window: Window;
  zone: string;
  hours: number[];
  apply: (c: Changes) => void;
}) {
  const { t } = useConsole();
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [err, setErr] = useState(false);
  const picked = params.has('from') ? 'custom' : params.get('hours') || '24';
  function toggle() {
    setEditing(true);
    setStart(localInput(w.start, zone));
    setEnd(localInput(w.end, zone));
    setErr(false);
  }
  function submit() {
    const a = parseLocal(start, zone),
      b = parseLocal(end, zone);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b - a > 31 * 86400000) {
      setErr(true);
      return;
    }
    apply({ hours: null, from: String(a), to: String(b) });
    setEditing(false);
  }
  return (
    <div className="range-control">
      <span className="range-choices" role="group" aria-label={t('时间窗口', 'Time window')}>
        <CalendarDays size={15} />
        {hours.map((h) => (
          <button
            key={h}
            aria-pressed={picked === String(h)}
            onClick={() => {
              setEditing(false);
              apply({ hours: String(h), from: null, to: null });
            }}
          >
            {h < 24 ? h + 'h' : h === 24 ? '24h' : h / 24 + 'd'}
          </button>
        ))}
        <button
          aria-pressed={picked === 'custom' || editing}
          onClick={editing ? () => setEditing(false) : toggle}
        >
          {t('自定义', 'Custom')}
        </button>
      </span>
      {editing && (
        <div className="date-edit">
          <label>
            {t('起始', 'From')}
            <input
              aria-label={t('起始时间', 'Window start')}
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            {t('结束', 'To')}
            <input
              aria-label={t('结束时间', 'Window end')}
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <small>{zone}</small>
          {err && (
            <p role="alert">
              {t('请输入有效的起止时间，窗口最多 31 天。', 'Enter a valid window of up to 31 days.')}
            </p>
          )}
          <div>
            <Btn small onPress={() => setEditing(false)}>
              {t('取消', 'Cancel')}
            </Btn>
            <Btn small primary onPress={submit}>
              {t('应用', 'Apply')}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
export interface NumberTile {
  label: string;
  value: string;
  unit?: string;
  note: string;
  icon: any;
  accent?: boolean;
}
export function NumberStrip({ items }: { items: NumberTile[] }) {
  return (
    <div className="diag-numbers">
      {items.map(({ label, value, unit, note, icon: Icon, accent }) => (
        <div className={'diag-number' + (accent ? ' accent' : '')} key={label}>
          <div>
            <span>{label}</span>
            <Icon size={16} />
          </div>
          <strong>
            {value}
            <small>{unit}</small>
          </strong>
          <p>{note}</p>
        </div>
      ))}
    </div>
  );
}
export function Pagination({
  page,
  total,
  size,
  change,
}: {
  page: number;
  total: number;
  size: number;
  change: (p: number) => void;
}) {
  const { t } = useConsole();
  const pages = Math.max(1, Math.ceil(total / size)),
    start = total ? page * size + 1 : 0;
  return (
    <footer className="diag-pagination">
      <span>
        {start}–{Math.min((page + 1) * size, total)} / {digits(total)} {t('条', 'rows')}
      </span>
      <div>
        <Btn
          small
          iconOnly
          disabled={!page}
          label={t('上一页', 'Previous page')}
          onPress={() => change(page - 1)}
        >
          <ChevronLeft size={15} />
        </Btn>
        <code>
          {page + 1} / {digits(pages)}
        </code>
        <Btn
          small
          iconOnly
          disabled={page + 1 >= pages}
          label={t('下一页', 'Next page')}
          onPress={() => change(page + 1)}
        >
          <ChevronRight size={15} />
        </Btn>
      </div>
    </footer>
  );
}
export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="inspect-kv">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
export function SideSheet({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const { t } = useConsole();
  return (
    <Drawer.Backdrop
      isOpen
      isDismissable
      onOpenChange={(v) => {
        if (!v) close();
      }}
      className="inspect-backdrop"
    >
      <Drawer.Content placement="right" className="inspect-container">
        <Drawer.Dialog aria-label={title} className="inspect-sheet">
          <Drawer.Header className="inspect-head">
            <Drawer.Heading>{title}</Drawer.Heading>
            <IconBtn icon={X} label={t('关闭', 'Close')} onPress={close} />
          </Drawer.Header>
          <Drawer.Body className="inspect-body">{children}</Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
export function pageNumber(s: string | null, total: number, size: number) {
  return Math.min(Math.max(0, Math.floor(Number(s) || 0)), Math.max(0, Math.ceil(total / size) - 1));
}
