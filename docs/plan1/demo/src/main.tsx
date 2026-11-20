import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from 'react-aria';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  Globe2,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PanelLeft,
  Search,
  Server,
  Sun,
} from 'lucide-react';
import { Dashboard } from './dashboard';
import { Observability } from './observability';
import { MutationDialog, PoolEditor, ProxyEditor } from './editors';
import { EndpointEditor } from './endpoint-editor';
import { ProjectEditor } from './project-editor';
import { Page, navLabels } from './model';
import { Playground } from './playground';
import { Records } from './records';
import { Proxies, Reference } from './resources';
import { Projects, Endpoints } from './config-pages';
import { ConfigInfo } from './config-info';
import { Languages } from './languages';
import { Provider, useConsole } from './state';
import { Brand, Btn, DialogFrame, Empty, Field, IconBtn, pageIcons } from './ui';
const groups: Page[][] = [
  ['overview', 'playground', 'requests', 'observability'],
  ['projects', 'endpoints', 'proxies', 'languages'],
  ['api'],
];
function Nav({ dialog = false }: { dialog?: boolean }) {
  const { t, l, page, go } = useConsole();
  return (
    <nav className={dialog ? 'dialog-nav' : 'nav'} aria-label={t('主导航', 'Main navigation')}>
      {groups.map((pages, i) => (
        <div className="nav-group" key={i}>
          <div className="nav-group-name">
            {[t('工作空间', 'Workspace'), t('资源配置', 'Resources'), t('参考', 'Reference')][i]}
          </div>
          {pages.map((p) => {
            const I = pageIcons[p];
            return (
              <button
                key={p}
                title={l(navLabels[p])}
                aria-label={l(navLabels[p])}
                aria-current={p === page ? 'page' : undefined}
                data-testid={'nav-' + p}
                onClick={() => go(p)}
              >
                <I size={17} />
                <span>{l(navLabels[p])}</span>
                {p === page && <i />}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
function EnvironmentButton() {
  const { t, open } = useConsole();
  return (
    <button className="environment-button" onClick={() => open('environment')}>
      <span className="env-icon">
        <Monitor size={18} />
      </span>
      <span>
        <b>{t('本地工作空间', 'Local workspace')}</b>
        <small>
          <i className="health-dot" />
          {t('演示环境', 'Demo environment')}
        </small>
      </span>
      <ChevronDown size={13} />
    </button>
  );
}
function Side() {
  const { go, t } = useConsole();
  return (
    <aside className="side">
      <button className="brand-home" onClick={() => go('overview')} aria-label="OpenAgentSearch">
        <Brand />
      </button>
      <EnvironmentButton />
      <Nav />
      <div className="side-foot">
        <div className="side-meta">
          <i className="health-dot" />
          {t('本地演示', 'Local demo')}
          <span>OAS</span>
        </div>
      </div>
    </aside>
  );
}
function Header() {
  const { page, lang, t, l, theme, toggleTheme, setLang, open } = useConsole();
  return (
    <header className="topbar">
      <div className="mobile-menu">
        <IconBtn icon={Menu} label={t('打开导航', 'Open navigation')} onPress={() => open('navigation')} />
      </div>
      <div className="breadcrumbs">
        <PanelLeft size={16} />
        <span>Atlas</span>
        <ChevronRight size={12} />
        <strong>{l(navLabels[page])}</strong>
      </div>
      <div className="top-tools">
        <button
          className="global-search"
          onClick={() => open('command')}
          aria-label={t('搜索页面与项目', 'Search pages and projects')}
        >
          <Search size={15} />
          <span>{t('搜索工作空间', 'Search workspace')}</span>
          <kbd>⌘ K</kbd>
        </button>
        <IconBtn
          icon={theme === 'light' ? Moon : Sun}
          label={t('切换配色', 'Toggle color theme')}
          onPress={toggleTheme}
          test="theme"
        />
        <button
          className="locale-button"
          aria-label={t('切换到英文', 'Switch to Chinese')}
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          data-testid="language"
        >
          {lang === 'zh' ? 'EN' : '中'}
        </button>
        <button
          className="avatar"
          aria-label={t('账户', 'Account')}
          title={t('账户', 'Account')}
          data-testid="account"
          onClick={() => open('account')}
        >
          OA
        </button>
      </div>
    </header>
  );
}
function PaletteDialog() {
  const { t, l, cfg, go, selectProject } = useConsole();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const items = [
    ...Object.entries(navLabels).map(([p, n]) => ({
      id: p,
      label: l(n),
      hint: t('页面', 'Page'),
      Icon: pageIcons[p as Page],
      run: () => go(p as Page),
    })),
    ...cfg.projects.map((p) => ({
      id: p.id,
      label: l(p.name),
      hint: t('项目调试', 'Project playground'),
      Icon: Folder,
      run: () => {
        selectProject(p);
        go('playground');
      },
    })),
  ].filter((r) => (r.label + ' ' + r.id).toLowerCase().includes(q.toLowerCase()));
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <DialogFrame title={t('搜索工作空间', 'Search workspace')}>
      <div className="cmd-input">
        <Search size={18} />
        <input
          aria-label={t('搜索页面或项目', 'Find a page or project')}
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          placeholder={t('输入页面、项目或英文名称', 'Type a page or project name')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
            }
            if (e.key === 'Enter') items[index]?.run();
          }}
        />
      </div>
      <div className="command-results">
        {items.map(({ id, label, hint, Icon, run }, i) => (
          <button key={id} className={i === index ? 'chosen' : ''} onClick={run}>
            <Icon size={16} />
            <b>{label}</b>
            <small>{hint}</small>
            <ArrowRight size={14} />
          </button>
        ))}
        {!items.length && <Empty text={t('没有匹配项', 'No matches')} />}
      </div>
    </DialogFrame>
  );
}
function Overlay() {
  const { dialog, t, cfg, setCfg, open, close, setSigned, theme, toggleTheme, lang, setLang } = useConsole();
  if (!dialog) return null;
  const { type, id } = dialog;
  for (const resource of ['project', 'endpoint', 'proxy', 'pool'] as const)
    if (type === resource + '-info') return <ConfigInfo id={id || ''} kind={resource} />;
  if (type === 'command') return <PaletteDialog />;
  if (type === 'navigation')
    return (
      <DialogFrame title={t('导航', 'Navigation')}>
        <Nav dialog />
        <button className="side-style" onClick={() => open('environment')}>
          <Monitor size={15} />
          {t('演示环境', 'Demo environment')}
        </button>
      </DialogFrame>
    );
  if (type === 'environment')
    return (
      <DialogFrame title={t('演示环境', 'Demo environment')}>
        <p className="muted">
          {t(
            '以下开关模拟 Helm 可选组件的可用状态。所有操作在浏览器本地完成。',
            'These switches simulate optional Helm components. All actions run locally in this browser.',
          )}
        </p>
        {(['searxng', 'crawl4ai'] as const).map((k) => (
          <label className="addon" key={k}>
            <span className="tile-icon">
              <Server size={19} />
            </span>
            <span>
              <b>{k === 'searxng' ? 'SearXNG' : 'Crawl4AI'}</b>
              <small>{k}.enabled</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={cfg.addons[k]}
              onChange={(e) => {
                const enabled = e.target.checked;
                setCfg((c) => ({ ...c, addons: { ...c.addons, [k]: enabled } }));
              }}
            />
          </label>
        ))}
      </DialogFrame>
    );
  if (type === 'account')
    return (
      <DialogFrame title={t('账户', 'Account')}>
        <div className="account-profile">
          <span className="avatar">OA</span>
          <div>
            <b>{t('演示管理员', 'Demo administrator')}</b>
            <small>{t('本地演示会话', 'Local demo session')}</small>
          </div>
        </div>
        <div className="account-actions">
          <Btn onPress={toggleTheme}>
            {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />} {t('切换配色', 'Toggle theme')}
          </Btn>
          <Btn onPress={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
            <Globe2 size={16} />
            {lang === 'zh' ? 'English' : '中文'}
          </Btn>
          <Btn
            onPress={() => {
              setSigned(false);
              close();
            }}
            test="logout"
          >
            <LogOut size={16} />
            {t('退出会话', 'Sign out')}
          </Btn>
        </div>
      </DialogFrame>
    );
  if (type === 'project') return <ProjectEditor key={id || 'new'} id={id} />;
  if (type === 'endpoint')
    return (
      <EndpointEditor
        key={id || 'new'}
        id={id}
        initialKind={dialog.value === 'reader' || dialog.value === 'model' ? dialog.value : 'search'}
      />
    );
  if (type === 'proxy') return <ProxyEditor key={id || 'new'} id={id} />;
  if (type === 'pool') return <PoolEditor key={id || 'new'} id={id} />;
  if (id && (type === 'key' || type === 'rotate' || type === 'toggle-proxy'))
    return <MutationDialog type={type} id={id} value={dialog.value} />;
  return null;
}
function SignIn() {
  const { t, setSigned, theme, toggleTheme, lang, setLang } = useConsole();
  const [name, setName] = useState('demo');
  const [pass, setPass] = useState('demo');
  const [invalid, setInvalid] = useState(false);
  function login() {
    if (name === 'demo' && pass === 'demo') setSigned(true);
    else setInvalid(true);
  }
  return (
    <main className="signin">
      <form
        className="login-form"
        onSubmit={(e) => {
          e.preventDefault();
          login();
        }}
      >
        <Brand />
        <h1>{t('登录控制台', 'Sign in to the console')}</h1>
        <p>{t('本地演示的账号和口令均为 demo。', 'The local demo username and password are both demo.')}</p>
        <Field
          label={t('用户名', 'Username')}
          value={name}
          change={(v) => {
            setName(v);
            setInvalid(false);
          }}
          required
        />
        <Field
          label={t('口令', 'Password')}
          type="password"
          value={pass}
          change={(v) => {
            setPass(v);
            setInvalid(false);
          }}
          required
        />
        {invalid && (
          <p className="form-error" role="alert">
            {t('演示账号或口令不匹配。', 'The demo credentials did not match.')}
          </p>
        )}
        <Btn primary type="submit" test="signin">
          {t('进入演示工作空间', 'Enter demo workspace')}
          <ArrowRight size={16} />
        </Btn>
        <div>
          <Btn small onPress={toggleTheme}>
            {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />} {t('配色', 'Theme')}
          </Btn>
          <Btn small onPress={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
            {lang === 'zh' ? 'English' : '中文'}
          </Btn>
        </div>
      </form>
    </main>
  );
}
function App() {
  const { page, signed, dialog, toast, lang } = useConsole();
  let content;
  switch (page) {
    case 'projects':
      content = <Projects />;
      break;
    case 'endpoints':
      content = <Endpoints />;
      break;
    case 'proxies':
      content = <Proxies />;
      break;
    case 'languages':
      content = <Languages />;
      break;
    case 'requests':
      content = <Records />;
      break;
    case 'observability':
      content = <Observability />;
      break;
    case 'api':
      content = <Reference />;
      break;
    case 'playground':
      content = <Playground />;
      break;
    default:
      content = <Dashboard />;
  }
  return (
    <I18nProvider locale={lang === 'zh' ? 'zh-CN' : 'en-US'}>
      {signed ? (
        <div className="app-shell skin-atlas">
          <Side />
          <section className="app-body">
            <Header />
            <main className={'main page-' + page} key={page}>
              {content}
            </main>
          </section>
        </div>
      ) : (
        <SignIn />
      )}
      {dialog && <Overlay />}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </I18nProvider>
  );
}
createRoot(document.getElementById('app')!).render(
  <Provider>
    <App />
  </Provider>,
);
