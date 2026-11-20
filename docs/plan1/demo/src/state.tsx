import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { DebugMemory } from './playground';
import { hydrateConfig, type StoredConfig } from './configuration';
import { EndpointDispatch } from './routing';
import { initialConfig, history } from './fixtures';
import { Config, Lang, Local, Log, Page, Project, local, navLabels } from './model';
interface Dialog {
  type: string;
  id?: string;
  value?: string;
}
function read<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem('oas-preview-2:' + key);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem('oas-preview-2:' + key, JSON.stringify(v));
  } catch {
    /* Storage is optional for file previews. */
  }
}
function route() {
  const [path, query = ''] = window.location.hash.slice(1).split('?');
  const [prefix, name, id = ''] = path.split('/');
  const page: Page = prefix === 'atlas' && Object.hasOwn(navLabels, name) ? (name as Page) : 'overview';
  return { page, id: page === name ? id : '', query };
}
const baseLogs = history();
function useApplication() {
  const [loc, setLoc] = useState(route);
  const [lang, setLang] = useState<Lang>(() => read('lang', 'zh'));
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    read(
      'theme',
      read<{ atlas?: 'light' | 'dark' }>('themes', {}).atlas ??
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    ),
  );
  const [cfg, publishCfg] = useState<Config>(() =>
    hydrateConfig(read<StoredConfig>('config', initialConfig())),
  );
  const [dispatcher] = useState(() => new EndpointDispatch(Date.now, undefined, {
    read: (id) => read<number>('risk:' + id, 0),
    write: (id, until) => save('risk:' + id, until),
  }));
  const configRef = React.useRef(cfg);
  function setCfg(change: (latest: Config) => Config) {
    const latest = hydrateConfig(read<StoredConfig>('config', configRef.current));
    let next: Config;
    try {
      next = change(latest);
    } catch (err) {
      configRef.current = latest;
      publishCfg(latest);
      throw err;
    }
    configRef.current = next;
    save('config', next);
    publishCfg(next);
  }
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== 'oas-preview-2:config') return;
      const latest = hydrateConfig(read<StoredConfig>('config', initialConfig()));
      configRef.current = latest;
      publishCfg(latest);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const [signed, publishSigned] = useState(true);
  const debugMemory = React.useRef<DebugMemory | null>(null);
  const routingDraft = React.useRef<{
    initial: Config['routes'];
    draft: Config['routes'];
    version: number;
  } | null>(null);
  function setSigned(v: boolean) {
    if (!v) {
      debugMemory.current = null;
      routingDraft.current = null;
    }
    publishSigned(v);
  }
  const [added, setAdded] = useState<Log[]>(() => read('runs', []));
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState('');
  const [projectId, setProjectId] = useState('coastal');
  const [period, setPeriod] = useState(7);
  const { page, id } = loc;
  const project = cfg.projects.find((p) => p.id === projectId) || cfg.projects[0];
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  const l = (v: Local) => local(v, lang);
  const logs = useMemo(() => [...added, ...baseLogs], [added]);
  useEffect(() => {
    const on = () => {
      setLoc(route());
      setDialog(null);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = theme;
    el.classList.toggle('dark', theme === 'dark');
    el.classList.toggle('light', theme === 'light');
    el.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = l(navLabels[page]) + ' · Atlas · OpenAgentSearch';
  }, [page, theme, lang]);
  useEffect(() => {
    save('theme', theme);
  }, [theme]);
  useEffect(() => {
    save('lang', lang);
  }, [lang]);
  useEffect(() => {
    save('runs', added);
  }, [added]);
  useEffect(() => {
    if (!toast) return;
    const tm = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(tm);
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && signed) {
        e.preventDefault();
        setDialog((v) => (v?.type === 'command' ? null : (v ?? { type: 'command' })));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [signed]);
  function go(p: Page, sel = '', query = '') {
    setDialog(null);
    const hash = ['atlas', p, ...(sel ? [sel] : [])].join('/') + (query ? '?' + query : '');
    if (location.hash.slice(1) !== hash) location.hash = hash;
    else setLoc({ page: p, id: sel, query });
  }
  function updateQuery(changes: Record<string, string | null>) {
    const next = new URLSearchParams(loc.query);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    const hash = ['atlas', page, ...(id ? [id] : [])].join('/') + (query ? '?' + query : '');
    window.history.replaceState(null, '', '#' + hash);
    setLoc({ ...loc, query });
  }
  return {
    query: loc.query,
    updateQuery,
    t,
    l,
    lang,
    setLang,
    page,
    id,
    theme,
    toggleTheme: () => setTheme((value) => (value === 'dark' ? 'light' : 'dark')),
    cfg,
    dispatcher,
    setCfg,
    logs,
    addLog: (log: Log) => setAdded((v) => [log, ...v].slice(0, 100)),
    project,
    debugMemory,
    routingDraft,
    selectProject: (p: Project) => setProjectId(p.id),
    go,
    dialog,
    open: (type: string, id?: string, value?: string) => setDialog({ type, id, value }),
    close: () => setDialog(null),
    toast,
    notify: setToast,
    period,
    setPeriod,
    signed,
    setSigned,
  };
}
type Store = ReturnType<typeof useApplication>;
const Ctx = createContext<Store | null>(null);
export const useConsole = () => useContext(Ctx)!;
export function Provider({ children }: { children: React.ReactNode }) {
  const store = useApplication();
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
