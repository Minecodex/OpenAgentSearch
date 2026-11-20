import { languageName } from './display-values';
import { useId, useState, type ReactNode } from 'react';
import { AlertDialog, Button } from '@heroui/react';
import { ArrowDown, ArrowUp, Check, Plus, X } from 'lucide-react';
import { useConsole } from './state';
import { Btn, Choice, DialogFrame, IconBtn } from './ui';
import { Lang } from './model';
import { installed } from './configuration';
import { firstLanguagePool } from './routing';

function DiscardChangesDialog({ keepEditing, discard }: { keepEditing: () => void; discard: () => void }) {
  const { t } = useConsole();
  const descriptionId = useId();
  return (
    <AlertDialog.Backdrop
      isOpen
      isDismissable={false}
      isKeyboardDismissDisabled={false}
      onOpenChange={(open) => {
        if (!open) keepEditing();
      }}
      onPointerDown={(event) => {
        // Keep keyboard focus in the alert when its non-dismissable backdrop is pressed.
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      className="oas-backdrop discard-backdrop"
    >
      <AlertDialog.Container placement="center" className="oas-container">
        <AlertDialog.Dialog aria-describedby={descriptionId} className="oas-dialog discard-dialog">
          <AlertDialog.Header>
            <AlertDialog.Heading>{t('放弃未保存的修改？', 'Discard unsaved changes?')}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body id={descriptionId}>
            {t('放弃后将关闭编辑器并丢弃本次草稿。', 'Discarding closes the editor and clears this draft.')}
          </AlertDialog.Body>
          <AlertDialog.Footer className="form-actions">
            <Button autoFocus variant="outline" className="ui-btn neutral" onPress={keepEditing}>
              {t('继续编辑', 'Keep editing')}
            </Button>
            <Button variant="danger" className="ui-btn discard-action" onPress={discard}>
              {t('放弃修改', 'Discard')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

export function EditorFrame({
  title,
  dirty,
  error,
  conflict,
  reload,
  save,
  children,
}: {
  title: string;
  dirty: boolean;
  error: string;
  conflict: boolean;
  reload: () => void;
  save: () => void;
  children: ReactNode;
}) {
  const { t, close } = useConsole();
  const [discard, setDiscard] = useState(false);
  const dismiss = () => (dirty ? setDiscard(true) : close());
  const footer = (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="diag-warning" role="alert">
          {t(
            '配置已更新，草稿保留。载入最新版本后可重新编辑。',
            'Configuration changed; your draft is retained. Reload the latest version to edit again.',
          )}{' '}
          <Btn small onPress={reload}>
            {t('载入最新版本', 'Reload latest')}
          </Btn>
        </div>
      )}
      <footer className="form-actions">
        <Btn onPress={dismiss}>{t('取消', 'Cancel')}</Btn>
        <Btn primary onPress={save} disabled={conflict} test="save-editor">
          <Check size={14} />
          {t('保存', 'Save')}
        </Btn>
      </footer>
    </>
  );
  return (
    <>
      <DialogFrame title={title} wide covered={discard} dismiss={dismiss} footer={footer}>
        <div className="form-stack">{children}</div>
      </DialogFrame>
      {discard && <DiscardChangesDialog keepEditing={() => setDiscard(false)} discard={close} />}
    </>
  );
}
export function CheckGroup<T extends string>({
  title,
  values,
  options,
  change,
}: {
  title: string;
  values: T[];
  options: { id: T; label: string }[];
  change: (v: T[]) => void;
}) {
  return (
    <fieldset className="check-group">
      <legend>{title}</legend>
      {options.map((o) => (
        <label key={o.id}>
          <input
            type="checkbox"
            checked={values.includes(o.id)}
            onChange={(e) => change(e.target.checked ? [...values, o.id] : values.filter((x) => x !== o.id))}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}
export function EndpointPools({
  kind,
  groups,
  language,
  change,
}: {
  kind: 'search' | 'reader';
  groups: string[][];
  language: Lang;
  change: (g: string[][]) => void;
}) {
  const { t, l, lang, cfg } = useConsole();
  const used = groups.flat();
  const endpoints = cfg.endpoints.filter((e) => e.kind === kind);
  const languageStart = kind === 'search' ? firstLanguagePool(groups, cfg.routes[language]) : -1;
  const prefix = kind === 'search' ? t('搜索', 'Search') : t('正文', 'Reader');
  function move(i: number, dir: number) {
    const next = [...groups];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    change(next);
  }
  return (
    <fieldset className="pool-builder">
      <legend>
        {prefix}
        {t('接入点池', ' pools')}
      </legend>
      {groups.map((g, i) => (
        <div className="endpoint-group" key={i}>
          <div className="group-title">
            <b>
              {t('优先级', 'Priority')} {i + 1}
            </b>
            {i === languageStart && (
              <span className="code-chip">
                {languageName(language, lang)} · {t('语言优先', 'Preferred language')}
              </span>
            )}
            <div>
              {i > 0 && (
                <Btn
                  small
                  label={prefix + t('池设为首选 ', ' pool as first ') + (i + 1)}
                  onPress={() => change([g, ...groups.filter((_, j) => i !== j)])}
                >
                  {t('设为首选', 'Make first')}
                </Btn>
              )}
              <Btn
                small
                iconOnly
                label={prefix + t('池上移 ', ' pool up ') + (i + 1)}
                disabled={!i}
                onPress={() => move(i, -1)}
              >
                <ArrowUp size={13} />
              </Btn>
              <Btn
                small
                iconOnly
                label={prefix + t('池下移 ', ' pool down ') + (i + 1)}
                disabled={i === groups.length - 1}
                onPress={() => move(i, 1)}
              >
                <ArrowDown size={13} />
              </Btn>
              <IconBtn
                icon={X}
                label={prefix + t('移除整组 ', ' remove pool ') + (i + 1)}
                onPress={() => change(groups.filter((_, idx) => i !== idx))}
              />
            </div>
          </div>
          <div className="member-chips">
            {g.map((id) => {
              const ep = endpoints.find((x) => x.id === id);
              return (
                <span className="member-chip" key={id}>
                  {ep ? l(ep.name) : t('已移除的接入点', 'Removed endpoint')}
                  {kind === 'search' &&
                    Object.entries(cfg.routes)
                      .filter(([, ids]) => ids.includes(id))
                      .map(([k]) => (
                        <small className="member-language" key={k}>
                          {languageName(k, lang)}
                        </small>
                      ))}
                  {!installed(cfg, id) && ' · ' + t('不可用', 'Unavailable')}
                  <button
                    aria-label={t('移除成员 ', 'Remove member ') + (ep ? l(ep.name) : id)}
                    onClick={() => change(groups.map((g, j) => (j === i ? g.filter((x) => x !== id) : g)))}
                  >
                    <X size={11} />
                  </button>
                </span>
              );
            })}
            <Choice
              value=""
              label={prefix + t('池添加成员 ', ' pool member ') + (i + 1)}
              onChange={(id) => {
                if (id && !used.includes(id)) change(groups.map((g, j) => (i === j ? [...g, id] : g)));
              }}
              options={[
                { value: '', label: t('添加成员', 'Add member') },
                ...endpoints
                  .filter((e) => installed(cfg, e.id) && !used.includes(e.id))
                  .map((e) => ({ value: e.id, label: l(e.name) })),
              ]}
            />
          </div>
        </div>
      ))}
      <Btn small onPress={() => change([...groups, []])} test={'add-' + kind + '-pool'}>
        <Plus size={13} />
        {t('新增', 'Add ')}
        {prefix}
        {t('池', ' pool')}
      </Btn>
    </fieldset>
  );
}
