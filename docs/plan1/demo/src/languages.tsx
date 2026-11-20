import { languageName } from './display-values';
import { useState, useEffect } from 'react';
import { Check, X, Plus } from 'lucide-react';
import { useConsole } from './state';
import { Lang } from './model';
import { installed, languages } from './configuration';
import { Btn, Caption, DialogFrame, PageHead, Panel, SelectField } from './ui';
export function Languages() {
  const { cfg, t, l, lang, setCfg, notify, go, routingDraft, query } = useConsole();
  const saved = routingDraft.current;
  const [initial, setInitial] = useState(() => structuredClone(saved?.initial ?? cfg.routes));
  const [confirmReload, askReload] = useState(false);
  const [draft, change] = useState(() => structuredClone(saved?.draft ?? cfg.routes)),
    [base, setBase] = useState(saved?.version ?? cfg.routesVersion),
    [err, error] = useState(''),
    [stale, conflict] = useState(false);
  const [picked, setPicked] = useState<Lang>(
      new URLSearchParams(query).get('language') === 'en' ? 'en' : 'zh',
    ),
    [member, setMember] = useState('');
  const choices = cfg.endpoints.filter((e) => e.kind === 'search' && installed(cfg, e.id));
  const dirty = languages.some((code) => {
    const a = initial[code],
      b = draft[code];
    return a && b ? a.length !== b.length || a.some((id) => !b.includes(id)) : a !== b;
  });
  const unavailable = Object.values(draft).some((ids) => ids.some((id) => !choices.some((e) => e.id === id)));
  useEffect(() => {
    routingDraft.current = dirty ? { initial, draft, version: base } : null;
  }, [dirty, draft, base, initial, routingDraft]);
  const outdated = stale || cfg.routesVersion !== base;
  function load() {
    askReload(false);
    setMember('');
    setInitial(structuredClone(cfg.routes));
    change(structuredClone(cfg.routes));
    setBase(cfg.routesVersion);
    conflict(false);
    error('');
  }
  function save() {
    try {
      setCfg((c) => {
        if (c.routesVersion !== base) throw Error('VERSION_CONFLICT');
        for (const ids of Object.values(draft)) {
          if (
            !ids.length ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !c.endpoints.some((e) => e.id === id && e.kind === 'search' && installed(c, id)))
          )
            throw Error('INVALID_MEMBERS');
        }
        return { ...c, routes: structuredClone(draft), routesVersion: base + 1 };
      });
      setInitial(structuredClone(draft));
      setBase(base + 1);
      error('');
      notify(t('语言路由已保存', 'Language routes saved'));
    } catch (e) {
      if ((e as Error).message === 'VERSION_CONFLICT') conflict(true);
      else
        error(
          t(
            '每行至少选择一个有效且不重复的搜索成员，或移除整行。',
            'Choose nonempty, unique and available search members per language, or remove the row.',
          ),
        );
    }
  }
  const available = choices.filter((e) => !draft[picked]?.includes(e.id));
  const validMember = available.some((e) => e.id === member);
  function addRule() {
    if (!validMember) return;
    set(picked, [...(draft[picked] ?? []), member]);
    setMember('');
    notify(t('规则已加入草稿，保存路由后生效。', 'Rule added to the draft. Save routes to apply it.'));
  }
  function remove(code: Lang, id?: string) {
    change((old) => {
      const next = { ...old },
        remaining = id ? (old[code] ?? []).filter((v) => v !== id) : [];
      if (remaining.length) next[code] = remaining;
      else delete next[code];
      return next;
    });
    error('');
  }
  const name = (id: string) =>
    l(cfg.endpoints.find((e) => e.id === id)?.name || t('已移除的接入点', 'Removed endpoint'));
  function set(lang: Lang, ids: string[]) {
    change((v) => ({ ...v, [lang]: ids }));
    error('');
  }
  return (
    <>
      <PageHead
        title={t('语言路由', 'Language routes')}
        sub={t(
          '搜索从首个命中业务语言的项目池开始，全池不可用时继续向后。',
          'Search starts at the first project pool matching the query language and moves forward if the pool is unavailable.',
        )}
      >
        <span className="code-chip">v{base}</span>
        <Btn onPress={() => go('endpoints', '', 'kind=search')}>{t('搜索接入点', 'Search endpoints')}</Btn>
        <Btn onPress={() => (dirty ? askReload(true) : load())}>{t('重载', 'Reload')}</Btn>
        <Btn primary disabled={!dirty || outdated} onPress={save}>
          <Check size={14} />
          {t('保存路由', 'Save routes')}
        </Btn>
      </PageHead>
      {confirmReload && (
        <DialogFrame title={t('重载语言路由', 'Reload language routes')} dismiss={() => askReload(false)}>
          <p>{t('重载会丢弃这份未保存的路由修改。', 'Reloading discards these unsaved routing changes.')}</p>
          <div className="form-actions">
            <Btn onPress={() => askReload(false)}>{t('继续编辑', 'Keep editing')}</Btn>
            <Btn primary onPress={load}>
              {t('放弃修改并重载', 'Discard and reload')}
            </Btn>
          </div>
        </DialogFrame>
      )}
      {unavailable && (
        <p role="alert" className="diag-warning">
          {t(
            '映射中有不可用的搜索接入点。可移除对应成员，或在接入点页检查组件状态。',
            'Some preferred endpoints are unavailable. Remove those members or check their components on the endpoints page.',
          )}
        </p>
      )}
      {outdated && (
        <p className="diag-warning">
          {t('配置版本已变化，请重载后再保存。', 'The route map changed. Reload before saving.')}
        </p>
      )}
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      <Panel className="route-map">
        <Caption title={t('语言优先规则', 'Language preference rules')}>
          <span className="muted">{dirty ? t('未保存', 'Unsaved') : t('已保存', 'Saved')}</span>
        </Caption>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('语言', 'Language')}</th>
                <th>{t('优先搜索成员', 'Preferred search members')}</th>
                <th>{t('操作', 'Action')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(draft).map(([code, members]) => (
                <tr key={code}>
                  <td>
                    <b>{languageName(code, lang)}</b>
                    <small className="row-sub mono">{code}</small>
                  </td>
                  <td>
                    <div className="member-chips">
                      {members.map((id) => (
                        <span className="member-chip" key={id}>
                          {name(id)}
                          {!installed(cfg, id) && ' · ' + t('不可用', 'Unavailable')}
                          <button
                            aria-label={t('移除优先成员 ', 'Remove preferred ') + code + ' ' + name(id)}
                            onClick={() => remove(code as Lang, id)}
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <button className="text-link" onClick={() => remove(code as Lang)}>
                      {t('移除语言', 'Remove language')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!Object.keys(draft).length && (
          <p className="route-empty">
            {t(
              '尚无优先规则，搜索按项目池顺序执行。',
              'No preferences configured. Searches follow project pool order.',
            )}
          </p>
        )}
      </Panel>
      <Panel className="rule-composer">
        <Caption title={t('添加规则', 'Add a rule')} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            addRule();
          }}
        >
          <div className="rule-fields">
            <SelectField
              label={t('规则语言', 'Rule language')}
              value={picked}
              onChange={(v) => {
                setPicked(v as Lang);
                setMember('');
              }}
              options={languages.map((value) => ({ value, label: languageName(value, lang) }))}
            />
            <SelectField
              label={t('优先搜索接入点', 'Preferred search endpoint')}
              value={validMember ? member : ''}
              onChange={setMember}
              options={[
                {
                  value: '',
                  label: available.length
                    ? t('选择搜索接入点', 'Choose a search endpoint')
                    : t('当前语言没有可添加的成员', 'No more members for this language'),
                },
                ...available.map((e) => ({ value: e.id, label: l(e.name) })),
              ]}
            />
            <Btn type="submit" disabled={!validMember || outdated}>
              <Plus size={15} />
              {t('添加规则', 'Add rule')}
            </Btn>
          </div>
        </form>
        <p className="rule-explanation">
          {t(
            '每种语言可以添加多个优先成员。规则只作用于项目已配置且符合请求条件的搜索接入点，保存后对新请求生效。',
            'A language can have multiple preferred members. Rules apply to eligible search endpoints configured for the project and take effect on new requests after saving.',
          )}
        </p>
      </Panel>
    </>
  );
}
