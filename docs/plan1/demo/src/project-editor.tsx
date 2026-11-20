import { languageName } from './display-values';
import { useState } from 'react';
import { Project, Lang } from './model';
import { useConsole } from './state';
import { Field, SelectField } from './ui';
import { CheckGroup, EditorFrame, EndpointPools } from './config-controls';
import { installed, languages, projectProblem } from './configuration';
export function newKey() {
  const b = crypto.getRandomValues(new Uint32Array(3));
  return 'demo_' + [...b].map((x) => x.toString(36)).join('');
}
export function ProjectEditor({ id }: { id?: string }) {
  const { t, l, lang, cfg, setCfg, notify, open, close } = useConsole();
  const src = cfg.projects.find((p) => p.id === id);
  function start(): Project {
    return src
      ? { ...src, name: l(src.name) }
      : {
          id: '',
          name: '',
          description: '',
          searchPools: [],
          readerPools: [],
          model: '',
          pool: '',
          language: 'zh',
          languages: ['zh', 'en'],
          searchLimit: 10,
          sourceLimit: 4,
          bodyLimit: 40000,
          summaryLimit: 1200,
          rewriteCount: 0,
          allowSnippets: false,
          version: 0,
        };
  }
  const [draft, setDraft] = useState<Project>(start);
  const [dirty, mark] = useState(false),
    [conflict, setConflict] = useState(false),
    [err, error] = useState('');
  function change(v: Partial<Project>) {
    setDraft((p) => ({ ...p, ...v }));
    mark(true);
    error('');
  }
  function submit() {
    const shape = { ...draft, name: String(draft.name).trim() };
    const issue = projectProblem(shape, cfg);
    if (issue) {
      error(t(issue[1], issue[2]));
      return;
    }
    const key = id || crypto.randomUUID();
    try {
      setCfg((c) => {
        const old = c.projects.find((p) => p.id === id);
        if (id && old?.version !== draft.version) throw Error('conflict');
        const invalid = projectProblem(shape, c);
        if (invalid) throw Error(t(invalid[1], invalid[2]));
        const p: Project = {
          ...shape,
          id: key,
          name: old && l(old.name) === shape.name ? old.name : shape.name,
          version: draft.version + 1,
        };
        return { ...c, projects: old ? c.projects.map((x) => (x.id === id ? p : x)) : [...c.projects, p] };
      });
      if (id) {
        close();
        notify(t('项目已更新', 'Project updated'));
      } else open('key', key, newKey());
    } catch (e) {
      if ((e as Error).message === 'conflict') setConflict(true);
      else error((e as Error).message);
    }
  }
  const numeric: [
    keyof Pick<Project, 'searchLimit' | 'sourceLimit' | 'bodyLimit' | 'summaryLimit' | 'rewriteCount'>,
    string,
  ][] = [
    ['searchLimit', t('最大搜索数量', 'Search limit')],
    ['sourceLimit', t('总结来源上限', 'Source limit')],
    ['bodyLimit', t('每页正文字数上限', 'Article character limit')],
    ['summaryLimit', t('整体总结字数上限', 'Summary character limit')],
    ['rewriteCount', t('额外改写数量（0–3）', 'Extra rewrites (0–3)')],
  ];
  return (
    <EditorFrame
      title={id ? t('编辑项目', 'Edit project') : t('新建项目', 'New project')}
      dirty={dirty}
      conflict={conflict}
      error={err}
      reload={() => {
        setDraft(start());
        mark(false);
        setConflict(false);
        error('');
      }}
      save={submit}
    >
      <h3 className="form-section">
        {t('项目设置', 'Project settings')}
        {id && <code>v{draft.version}</code>}
      </h3>
      <Field
        label={t('项目名称', 'Project name')}
        required
        test="project-name"
        value={String(draft.name)}
        change={(name) => change({ name })}
      />
      <CheckGroup
        title={t('允许的业务语言', 'Allowed languages')}
        values={draft.languages}
        options={languages.map((id) => ({ id, label: languageName(id, lang) }))}
        change={(ls) =>
          change({
            languages: ls,
            language: ls.includes(draft.language) ? draft.language : (ls[0] ?? draft.language),
          })
        }
      />
      <div className="form-grid">
        <SelectField
          label={t('默认业务语言', 'Default content language')}
          value={draft.language}
          onChange={(v) => change({ language: v as Lang })}
          options={draft.languages.map((value) => ({ value, label: languageName(value, lang) }))}
        />
      </div>
      <h3 className="form-section">{t('搜索与正文能力', 'Search and article capabilities')}</h3>
      <EndpointPools
        kind="search"
        groups={draft.searchPools}
        language={draft.language}
        change={(g) => change({ searchPools: g })}
      />
      <EndpointPools
        kind="reader"
        groups={draft.readerPools}
        language={draft.language}
        change={(g) => change({ readerPools: g })}
      />
      <div className="form-grid">
        <SelectField
          label={t('生成模型', 'Generation model')}
          value={draft.model}
          onChange={(model) => change({ model })}
          options={[
            { value: '', label: t('未配置', 'Unconfigured') },
            ...cfg.endpoints
              .filter((e) => e.kind === 'model' && installed(cfg, e.id))
              .map((e) => ({ value: e.id, label: l(e.name) })),
          ]}
        />
        <SelectField
          label={t('浏览器代理池', 'Browser proxy pool')}
          value={draft.pool}
          onChange={(pool) => change({ pool })}
          options={[
            { value: '', label: t('不绑定', 'Unbound') },
            ...cfg.pools.map((p) => ({ value: p.id, label: l(p.name) })),
          ]}
        />
      </div>
      <h3 className="form-section">{t('限制与总结策略', 'Limits and synthesis')}</h3>
      <div className="form-grid">
        {numeric.map(([k, label]) => (
          <Field
            key={k}
            type="number"
            label={label}
            value={Number.isFinite(draft[k]) ? String(draft[k]) : ''}
            change={(s) => change({ [k]: s === '' ? NaN : Number(s) })}
          />
        ))}
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={draft.allowSnippets}
          onChange={(e) => change({ allowSnippets: e.target.checked })}
        />
        {t(
          '普通正文提取失败时允许使用该候选的简介',
          'Allow a snippet after an ordinary article retrieval failure',
        )}
      </label>
      <p className="panel-help">
        {t(
          '改写始终保留原问题。设为 0 时跳过改写，显式时间范围仍按接入点能力筛选。',
          'Rewrites retain the original question. Zero skips rewriting; explicit time windows still require a capable search source.',
        )}
      </p>
    </EditorFrame>
  );
}
