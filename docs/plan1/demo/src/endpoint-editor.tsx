import { providerCatalog, providerNames } from './endpoint-providers';
import { rangeNames, languageName } from './display-values';
import { useState } from 'react';
import { Endpoint, EndpointProvider, AdapterOptions, Kind, kinds } from './model';
import {
  defaultOptions,
  defaultEndpointTimeout,
  endpointProblem,
  isBrowser,
  languages,
  ranges,
} from './configuration';
import { useConsole } from './state';
import { Field, SelectField } from './ui';
import { CheckGroup, EditorFrame } from './config-controls';
export function EndpointEditor({ id, initialKind = 'search' }: { id?: string; initialKind?: Kind }) {
  const { t, l, lang, cfg, setCfg, notify, close } = useConsole();
  const src = cfg.endpoints.find((x) => x.id === id);
  const blank = (): Endpoint => ({
    id: '',
    name: '',
    kind: initialKind,
    provider: providerCatalog[initialKind][0].provider,
    adapter: providerCatalog[initialKind][0].adapter,
    options: defaultOptions(providerCatalog[initialKind][0].adapter),
    timeoutMs: defaultEndpointTimeout(initialKind),
    limit: 4,
    rpm: 60,
    address: '',
    version: 0,
    hasSecret: false,
  });
  const [draft, update] = useState<Endpoint>(() => (src ? { ...src, name: l(src.name) } : blank()));
  const [seconds, setSeconds] = useState(String(draft.timeoutMs / 1000));
  const [dirty, mark] = useState(false);
  const [action, secretAction] = useState<'keep' | 'replace' | 'clear'>('keep'),
    [key, setKey] = useState(''),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(false);
  function patch(v: Partial<Endpoint>) {
    mark(true);
    setError('');
    update((old) => ({ ...old, ...v }));
  }
  function options(v: Partial<AdapterOptions>) {
    patch({ options: { ...draft.options, ...v } });
  }
  function selectProvider(provider: EndpointProvider) {
    const preset = providerCatalog[draft.kind].find((v) => v.provider === provider);
    if (!preset) return;
    patch({ ...preset, options: defaultOptions(preset.adapter), address: '', hasSecret: false });
    secretAction('keep');
    setKey('');
  }
  const clean: Endpoint = {
    ...draft,
    name: String(draft.name).trim(),
    timeoutMs: Number(seconds) * 1000,
    address: draft.address.trim(),
  };
  const actualAction = isBrowser(clean.adapter) ? 'keep' : action;
  function reload() {
    if (!src) return;
    update({ ...src, name: l(src.name) });
    setSeconds(String(src.timeoutMs / 1000));
    secretAction('keep');
    setKey('');
    setError('');
    mark(false);
    setConflict(false);
  }
  function submit() {
    const issue = endpointProblem(clean, actualAction, key);
    if (issue) {
      setError(t(issue[1], issue[2]));
      return;
    }
    try {
      setCfg((c) => {
        const old = c.endpoints.find((x) => x.id === id);
        if (id && old?.version !== draft.version) throw Error('conflict');
        const e = {
          ...clean,
          id: id || crypto.randomUUID(),
          name: old && l(old.name) === clean.name ? old.name : clean.name,
          version: draft.version + 1,
          hasSecret: isBrowser(clean.adapter)
            ? false
            : actualAction === 'keep'
              ? !!old?.hasSecret && old.provider === clean.provider
              : actualAction === 'replace',
          lastTest: undefined,
        };
        return { ...c, endpoints: old ? c.endpoints.map((v) => (v.id === id ? e : v)) : [...c.endpoints, e] };
      });
      close();
      notify(t('接入点已保存', 'Endpoint saved'));
    } catch {
      setConflict(true);
    }
  }
  return (
    <EditorFrame
      title={
        src
          ? t('编辑接入点', 'Edit endpoint')
          : t(
              '添加' + l(kinds[draft.kind]) + '接入点',
              'Add ' + l(kinds[draft.kind]).toLowerCase() + ' endpoint',
            )
      }
      dirty={dirty}
      error={error}
      conflict={conflict}
      reload={reload}
      save={submit}
    >
      <h3 className="form-section">
        {t('能力与连接', 'Capability and connection')}
        {src && <code>v{draft.version}</code>}
      </h3>
      {src?.provider ? (
        <div className="config-fixed">
          <b>{l(kinds[draft.kind])}</b>
          <span>{l(providerNames[src.provider])}</span>
          {src.builtin && <span>{t('系统内置', 'System endpoint')}</span>}
        </div>
      ) : (
        <SelectField
          label={t('服务商', 'Provider')}
          value={draft.provider ?? ''}
          onChange={(v) => selectProvider(v as EndpointProvider)}
          options={[
            ...(draft.provider ? [] : [{ value: '', label: t('选择服务商', 'Select a provider') }]),
            ...providerCatalog[draft.kind].map((v) => ({
              value: v.provider,
              label: l(providerNames[v.provider]),
            })),
          ]}
        />
      )}
      <Field
        label={t('名称', 'Name')}
        value={String(draft.name)}
        change={(s) => patch({ name: s })}
        required
      />
      {isBrowser(draft.adapter) ? (
        <p className="panel-help">
          {t(
            '执行器地址由部署提供，出口从项目的代理池分配。',
            'The deployment supplies the worker; the project supplies the proxy pool.',
          )}
        </p>
      ) : (
        <Field
          label={t('服务基址', 'Base URL')}
          value={draft.address}
          change={(s) => patch({ address: s })}
          placeholder="https://service.example.org"
        />
      )}
      <h3 className="form-section">{t('服务选项', 'Provider settings')}</h3>
      {draft.kind === 'search' && (
        <>
          {draft.adapter === 'browser_search' && (
            <Field
              label={t('引擎标识', 'Engine ID')}
              value={draft.options.engine || ''}
              change={(s) => options({ engine: s })}
            />
          )}
          {draft.provider === 'searxng' && (
            <Field
              label={t('引擎列表（逗号分隔）', 'Engines (comma separated)')}
              value={(draft.options.engines ?? []).join(',')}
              change={(s) => options({ engines: s ? s.split(',').map((x) => x.trim()) : [] })}
            />
          )}
          <CheckGroup
            title={t('支持的检索语言', 'Search languages')}
            values={draft.options.languages ?? []}
            options={languages.map((id) => ({ id, label: languageName(id, lang) }))}
            change={(v) => options({ languages: v })}
          />
          <CheckGroup
            title={t('支持的时间条件', 'Supported time filters')}
            values={draft.options.time_ranges ?? []}
            options={ranges.map((id) => ({ id, label: l(rangeNames[id]) }))}
            change={(v) => options({ time_ranges: v })}
          />
        </>
      )}
      {draft.adapter === 'http_reader' && (
        <SelectField
          label={t('上游正文格式', 'Upstream article format')}
          value={draft.options.format ?? 'markdown'}
          onChange={(v) => options({ format: v as 'html' | 'markdown' })}
          options={[
            { value: 'html', label: 'HTML' },
            { value: 'markdown', label: 'Markdown' },
          ]}
        />
      )}
      {draft.adapter === 'browser_reader' && (
        <p className="panel-help">
          {t(
            '从渲染后的主文档提取文章，同时生成 Markdown 和纯文本。',
            'Extracts the rendered article for both Markdown and plain text.',
          )}
        </p>
      )}
      {draft.kind === 'model' && (
        <div className="form-grid">
          <Field
            label={t('模型标识', 'Model ID')}
            value={draft.options.model ?? ''}
            change={(s) => options({ model: s })}
          />
          <Field
            label={t('分词器标识', 'Tokenizer ID')}
            value={draft.options.tokenizer ?? ''}
            change={(s) => options({ tokenizer: s })}
          />
          <Field
            label={t('最大输入 Token', 'Max input tokens')}
            type="number"
            value={String(draft.options.max_input_tokens ?? '')}
            change={(s) => options({ max_input_tokens: Number(s) })}
          />
          <Field
            label={t('最大输出 Token', 'Max output tokens')}
            type="number"
            value={String(draft.options.max_output_tokens ?? '')}
            change={(s) => options({ max_output_tokens: Number(s) })}
          />
        </div>
      )}
      <h3 className="form-section">{t('运行限制', 'Runtime limits')}</h3>
      <div className="form-grid">
        <Field
          label={t('单次超时（秒）', 'Timeout (seconds)')}
          type="number"
          value={seconds}
          change={(s) => {
            setSeconds(s);
            mark(true);
          }}
        />
        <Field
          label={t('最大并发', 'Concurrency')}
          type="number"
          value={String(draft.limit)}
          change={(s) => patch({ limit: Number(s) })}
        />
        <Field
          label={t('每分钟请求上限', 'Requests per minute')}
          type="number"
          value={String(draft.rpm)}
          change={(s) => patch({ rpm: Number(s) })}
        />
      </div>
      {!isBrowser(draft.adapter) && (
        <>
          <h3 className="form-section">
            {t('上游凭据', 'Upstream credentials')}
            <small>{draft.hasSecret ? t('已配置', 'Configured') : t('未配置', 'Not configured')}</small>
          </h3>
          <SelectField
            label={t('凭据操作', 'Credential action')}
            value={action}
            onChange={(v) => {
              secretAction(v as typeof action);
              setKey('');
              mark(true);
            }}
            options={[
              { value: 'keep', label: src ? t('保留', 'Keep') : t('不提供', 'Omit') },
              { value: 'replace', label: t('设置新 Key', 'Set a new key') },
              ...(src?.hasSecret
                ? [{ value: 'clear', label: t('清除已保存凭据', 'Clear saved credentials') }]
                : []),
            ]}
          />
          {action === 'replace' && (
            <Field
              type="password"
              label={t('示例 API Key', 'Sample API key')}
              value={key}
              change={(s) => {
                setKey(s);
                mark(true);
              }}
            />
          )}
          {action === 'clear' && (
            <p className="diag-warning">
              {t('保存后后续调用将不再使用该凭据。', 'Saving removes this credential from subsequent calls.')}
            </p>
          )}
        </>
      )}
    </EditorFrame>
  );
}
