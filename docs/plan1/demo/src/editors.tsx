import { EditorFrame } from './config-controls';
import { newKey } from './project-editor';
import { useState } from 'react';
import { Clipboard } from 'lucide-react';
import { Pool, ProxyNode, uid } from './model';
import { useConsole } from './state';
import { Btn, DialogFrame, Field, SelectField, useCopy } from './ui';
export function ProxyEditor({ id }: { id?: string }) {
  const { t, l, cfg, setCfg, close, notify } = useConsole();
  const src = cfg.proxies.find((p) => p.id === id);
  const [name, setName] = useState(src ? l(src.name) : '');
  const [scheme, setScheme] = useState(src?.scheme || 'socks5');
  const [host, setHost] = useState(src?.host || '');
  const [port, setPort] = useState('' + (src?.port ?? 1080));
  const [limit, setLimit] = useState('' + (src?.limit ?? 4));
  const [auth, setAuth] = useState(src?.auth || false);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [base, setBase] = useState(src);
  const [conflict, setConflict] = useState(false);
  const expected = base?.version ?? 1;
  const dirty =
    name !== (base ? l(base.name) : '') ||
    scheme !== (base?.scheme ?? 'socks5') ||
    host !== (base?.host ?? '') ||
    port !== String(base?.port ?? 1080) ||
    limit !== String(base?.limit ?? 4) ||
    auth !== !!base?.auth ||
    !!user ||
    !!password;
  function reload() {
    if (id && !src) {
      close();
      return;
    }
    setBase(src);
    setName(src ? l(src.name) : '');
    setScheme(src?.scheme ?? 'socks5');
    setHost(src?.host ?? '');
    setPort(String(src?.port ?? 1080));
    setLimit(String(src?.limit ?? 4));
    setAuth(!!src?.auth);
    setUser('');
    setPassword('');
    error('');
    setConflict(false);
  }
  const [err, error] = useState('');
  function submit() {
    if (
      !name.trim() ||
      !host.trim() ||
      /[\s/@?#]/.test(host) ||
      ![+port, +limit].every((n) => Number.isInteger(n) && n > 0) ||
      +port > 65535
    )
      return error(t('请检查名称、主机、端口与并发数。', 'Check name, host, port and concurrency.'));
    if (auth && (!src?.auth || user || password) && (!user.trim() || !password))
      return error(t('请同时填写示例用户名和口令。', 'Enter both sample username and password.'));
    const item: ProxyNode = {
      version: id ? expected + 1 : 1,
      id: id || uid('proxy'),
      name: src && name === l(src.name) ? src.name : name.trim(),
      scheme,
      host: host.trim(),
      port: +port,
      limit: +limit,
      auth,
      enabled: src?.enabled ?? true,
    };
    try {
      setCfg((c) => {
        const current = c.proxies.find((p) => p.id === id);
        if (id && (!current || (current.version ?? 1) !== expected)) throw Error('conflict');
        return { ...c, proxies: id ? c.proxies.map((p) => (p.id === id ? item : p)) : [...c.proxies, item] };
      });
    } catch {
      setConflict(true);
      return;
    }
    close();
    notify(t('代理已保存', 'Proxy saved'));
  }
  return (
    <EditorFrame
      title={id ? t('编辑代理', 'Edit proxy') : t('添加代理', 'Add proxy')}
      dirty={dirty}
      conflict={conflict}
      error={err}
      reload={reload}
      save={submit}
    >
      <Field label={t('显示名', 'Display name')} value={name} change={setName} required />
      <div className="form-grid">
        <SelectField
          label={t('协议', 'Protocol')}
          value={scheme}
          onChange={(v) => {
            setScheme(v as any);
            setPort(v === 'https' ? '443' : '1080');
          }}
          options={['socks5', 'https'].map((value) => ({ value, label: value.toUpperCase() }))}
        />
        <Field label={t('最大并发', 'Concurrency')} value={limit} change={setLimit} type="number" />
        <Field label={t('主机', 'Host')} value={host} change={setHost} placeholder="proxy.example.org" />
        <Field label={t('端口', 'Port')} type="number" value={port} change={setPort} />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={auth} onChange={(e) => setAuth(e.target.checked)} />
        {t('用户名和口令认证', 'Username and password authentication')}
      </label>
      {auth && (
        <div className="form-grid">
          <Field label={t('示例用户名', 'Sample username')} value={user} change={setUser} />
          <Field
            label={t('示例口令', 'Sample password')}
            type="password"
            value={password}
            change={setPassword}
          />
        </div>
      )}
    </EditorFrame>
  );
}
export function PoolEditor({ id }: { id?: string }) {
  const { t, l, cfg, setCfg, close, notify } = useConsole();
  const src = cfg.pools.find((x) => x.id === id);
  const [name, setName] = useState(src ? l(src.name) : '');
  const [members, setMembers] = useState(src?.members || []);
  const [base, setBase] = useState(src),
    [conflict, setConflict] = useState(false);
  const dirty =
    name !== (base ? l(base.name) : '') ||
    members.length !== (base?.members.length ?? 0) ||
    members.some((m) => !base?.members.some((x) => x.id === m.id && x.weight === m.weight));
  function reload() {
    if (id && !src) {
      close();
      return;
    }
    setBase(src);
    setName(src ? l(src.name) : '');
    setMembers(src?.members ?? []);
    setConflict(false);
    error('');
  }
  const [err, error] = useState('');
  function submit() {
    if (
      !name.trim() ||
      !members.length ||
      members.some((m) => !Number.isInteger(m.weight) || m.weight <= 0 || m.weight > 100)
    )
      return error(
        t(
          '请填写名称，选择成员并设置 1–100 的权重。',
          'Enter a name and select members with weights from 1 to 100.',
        ),
      );
    const item: Pool = {
      id: id || uid('pool'),
      version: (base?.version ?? 0) + 1,
      name: base && name === l(base.name) ? base.name : name.trim(),
      members,
    };
    try {
      setCfg((c) => {
        const old = c.pools.find((x) => x.id === id);
        if (id && (!old || (old.version ?? 1) !== (base?.version ?? 1))) throw Error('VERSION_CONFLICT');
        if (members.some((m) => !c.proxies.some((p) => p.id === m.id))) throw Error('INVALID_MEMBERS');
        return { ...c, pools: id ? c.pools.map((p) => (p.id === id ? item : p)) : [...c.pools, item] };
      });
    } catch (err) {
      if ((err as Error).message === 'VERSION_CONFLICT') setConflict(true);
      else
        error(t('所选的代理已移除，请重新选择成员。', 'A selected proxy was removed. Update the members.'));
      return;
    }
    close();
    notify(t('代理池已保存', 'Proxy pool saved'));
  }
  return (
    <EditorFrame
      title={id ? t('编辑代理池', 'Edit proxy pool') : t('新建代理池', 'New proxy pool')}
      dirty={dirty}
      conflict={conflict}
      error={err}
      reload={reload}
      save={submit}
    >
      <Field label={t('代理池名称', 'Pool name')} value={name} change={setName} />
      {cfg.proxies.map((p) => {
        const member = members.find((m) => m.id === p.id);
        return (
          <div className="pool-member" key={p.id}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!member}
                onChange={(e) =>
                  setMembers((v) =>
                    e.target.checked ? [...v, { id: p.id, weight: 1 }] : v.filter((m) => m.id !== p.id),
                  )
                }
              />
              {l(p.name)}
            </label>
            {member && (
              <label>
                {t('权重', 'Weight')}{' '}
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={member.weight}
                  onChange={(e) =>
                    setMembers((v) =>
                      v.map((m) => (m.id === p.id ? { ...m, weight: Number(e.target.value) } : m)),
                    )
                  }
                />
              </label>
            )}
          </div>
        );
      })}
    </EditorFrame>
  );
}
export function MutationDialog({
  type,
  id,
  value,
}: {
  type: 'key' | 'rotate' | 'toggle-proxy';
  id: string;
  value?: string;
}) {
  const { t, cfg, setCfg, notify, close, open } = useConsole();
  const copy = useCopy();
  if (type === 'key')
    return (
      <DialogFrame title={t('项目演示 Key', 'Demo project key')}>
        <p>{t('此值只在此窗口显示一次。', 'This value is shown once in this dialog.')}</p>
        <pre className="code-box">{value}</pre>
        <div className="form-actions">
          <Btn onPress={() => void copy(value || '')}>
            <Clipboard size={14} />
            {t('复制', 'Copy')}
          </Btn>
          <Btn primary onPress={close}>
            {t('完成', 'Done')}
          </Btn>
        </div>
      </DialogFrame>
    );
  const proxy = cfg.proxies.find((p) => p.id === id);
  const isRotate = type === 'rotate';
  if (!isRotate && !proxy) return null;
  const title = isRotate
    ? t('轮换项目 Key', 'Rotate project key')
    : proxy?.enabled
      ? t('停用代理', 'Disable proxy')
      : t('启用代理', 'Enable proxy');

  function submit() {
    if (isRotate) {
      try {
        setCfg((v) => {
          if (v.projects.find((p) => p.id === id)?.version !== Number(value)) throw Error('VERSION_CONFLICT');
          return {
            ...v,
            projects: v.projects.map((p) => (p.id === id ? { ...p, version: p.version + 1 } : p)),
          };
        });
      } catch {
        notify(t('版本已变化，请重新打开操作。', 'Version changed. Reopen the action.'));
        return;
      }
      open('key', id, newKey());
      return;
    }
    setCfg((v) => ({
      ...v,
      proxies: v.proxies.map((p) =>
        p.id === id
          ? { ...p, enabled: !p.enabled, version: (p.version ?? 1) + 1, tested: undefined, lastTest: undefined }
          : p,
      ),
    }));
    close();
    notify(t('配置已更新', 'Configuration updated'));
  }
  return (
    <DialogFrame title={title}>
      <p>
        {isRotate
          ? t('继续后会生成新的演示凭据。', 'Continuing generates a new demo credential.')
          : t(
              '此变更会影响后续浏览器任务的可用出口。',
              'This changes egress availability for subsequent browser jobs.',
            )}
      </p>
      <footer className="form-actions">
        <Btn onPress={close}>{t('关闭', 'Close')}</Btn>
        <Btn primary onPress={submit}>
          {t('确认', 'Confirm')}
        </Btn>
      </footer>
    </DialogFrame>
  );
}
