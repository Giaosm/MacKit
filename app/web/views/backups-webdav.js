/**
 * MacKit · 备份中心 · WebDAV 备份（非路由模块）
 *
 * ⚠ 本模块**不是** app.js 的路由视图：`VIEW_MODULES` 是显式白名单，切勿把
 *   `backups-webdav` 之类加进去（那会多出一个空白路由页）。它只被
 *   `views/backups.js` 以相对路径 `import './backups-webdav.js'` 引入。
 * ⚠ 必须落在 `web/` 目录下：静态服务根就是 `web/`，放到别处会 404 →
 *   ESM 加载失败 → **整页白屏**。
 *
 * 提供的构建函数（对齐《MacKit-WebDAV-设计.md》§2 / §7）：
 *   - buildWebdavSection(ctx)  → 「WebDAV 备份」区块（3 个按钮）DOM 节点
 *   - openRecordsModal(ctx)    → 弹窗 A：远程备份记录（加载态 / 统计行 / 恢复 / 删除）
 *   - openSettingsModal(ctx)   → 弹窗 B：WebDAV 设置（密码显示切换 / 保存 + 自动探测）
 *
 * 契约（§6.1，脱敏，永不回显密码）：
 *   GET  /api/webdav/config   → { url, username, hasPassword, allowInsecureTLS, configured }
 *   PUT  /api/webdav/config   → { url, username, password?, allowInsecureTLS } → 脱敏对象
 *   GET  /api/webdav/backups  → { configured, count, items:[{ name, url, lastModified, size }] }
 *   POST /api/tasks           → { module:'backup', action:'webdav_backup'|'webdav_restore'|'webdav_delete', params, confirm? }
 *
 * 约束：零依赖 —— 本文件**没有任何 import**（只用 ctx 能力 + 内联 DOM）。
 *       弹窗一律走 ctx.ui.modal / ctx.ui.confirmDialog（同屏单例 + close 幂等），
 *       不新建弹窗体系；异步拉数据回来前先做 isConnected 竞态校验，避免写已卸载的 DOM。
 */

/**
 * 可读化字节数（与 views/backups.js 的 humanSize 语义一致）。
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
function humanSize(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const b = Number(bytes);
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 构建「WebDAV 备份」区块（与页面其它卡同一视觉体系）。
 * 布局：说明行 + [备份] [查看记录] … [配置 WEBDAV]。
 * @param {object} ctx 视图上下文（el / ui / api / runTask / fmtRel / fmtDateTime / …）
 * @returns {HTMLElement}
 */
export function buildWebdavSection(ctx) {
  const { el, ui } = ctx;

  const backupBtn = el('button', { class: 'btn btn--primary', type: 'button', text: '备份' });
  const recordsBtn = el('button', { class: 'btn', type: 'button', text: '查看记录' });
  const configBtn = el('button', { class: 'btn', type: 'button', text: '配置 WEBDAV' });

  backupBtn.addEventListener('click', () => runBackup(ctx, backupBtn));
  recordsBtn.addEventListener('click', () => openRecordsModal(ctx));
  configBtn.addEventListener('click', () => openSettingsModal(ctx));

  return ui.card('☁ WebDAV 备份', el('div', {}, [
    el('div', { class: 'muted', text: '把本机配置备份到你的 WebDAV 服务器（NAS）' }),
    el('div', { class: 'row row--between section' }, [
      el('div', { class: 'row' }, [backupBtn, recordsBtn]),
      configBtn,
    ]),
  ]));
}

/**
 * 立即备份：直接跑 `webdav_backup`（新增文件、不覆盖本机任何东西，故无需二次确认）。
 * 走既有任务流（SSE 实时日志 + 可取消），完成后给 toast。
 * @param {object} ctx
 * @param {HTMLButtonElement} btn 点击的按钮（用于忙碌态）
 */
async function runBackup(ctx, btn) {
  const idle = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 备份中…';
  try {
    const t = await ctx.runTask('backup', 'webdav_backup', {});
    if (t === null) return; // 已有任务在运行，runTask 内部已 toast 提示
    if (t.status === 'ok') ctx.ui.toast('ok', '已备份到 WebDAV');
    else if (t.status === 'cancelled') ctx.ui.toast('warn', '备份已取消');
    else ctx.ui.toast('err', '备份失败，请查看日志');
  } catch {
    /* runTask 提交失败时内部已 toast，这里不重复 */
  } finally {
    btn.disabled = false;
    btn.textContent = idle;
  }
}

/**
 * 弹窗 A：WebDAV 备份记录。
 * @param {object} ctx
 */
export function openRecordsModal(ctx) {
  const { el, ui, api } = ctx;

  const statEl = el('span', { class: 'muted' });
  const host = el('div');
  const refreshBtn = el('button', { class: 'btn btn--sm', type: 'button', text: '⟳ 刷新' });
  let busy = false;

  const setStat = (text) => { statEl.textContent = text || ''; };
  refreshBtn.addEventListener('click', () => { load(); });

  const body = el('div', {}, [
    el('div', { class: 'row row--between section' }, [statEl, refreshBtn]),
    host,
  ]);

  async function load() {
    if (busy) return;
    busy = true;
    // 刷新按钮的可见反馈（本项目原则：任何刷新按钮都不能「点了没反应」）
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⏳ 刷新中…';
    setStat('');
    host.innerHTML = '';
    host.append(el('div', { class: 'view-loading', text: '正在读取远程备份…' }));
    try {
      const data = await api('GET', '/api/webdav/backups');
      if (!host.isConnected) return; // 竞态：用户已关闭弹窗 → 不写 DOM
      renderList(data);
    } catch (err) {
      if (!host.isConnected) return;
      setStat('');
      host.innerHTML = '';
      host.append(el('div', { class: 'err-box', text: `读取失败：${err.message || err}` }));
      host.append(el('div', { class: 'muted section', text: '请检查「配置 WEBDAV」中的地址与凭据，或稍后点「刷新」重试。' }));
    } finally {
      busy = false;
      if (refreshBtn.isConnected) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '⟳ 刷新';
      }
    }
  }

  function renderList(data) {
    host.innerHTML = '';
    if (!data || data.configured === false) {
      setStat('');
      host.append(ui.empty({
        icon: '☁',
        title: '尚未配置 WebDAV',
        text: '先在「WebDAV 设置」里填写服务器地址，之后即可在这里查看远程备份记录。',
        actions: [{ label: '去配置', kind: 'primary', onClick: () => openSettingsModal(ctx) }],
      }));
      return;
    }
    const items = Array.isArray(data.items) ? data.items.slice() : [];
    // 服务端已按时间倒序；这里再兜一次，容错任何顺序
    items.sort((a, b) => (Number(b.lastModified) || 0) - (Number(a.lastModified) || 0));
    const latest = items.length ? (Number(items[0].lastModified) || 0) : 0;
    setStat(items.length
      ? `共 ${items.length} 份备份 · 最近 ${ctx.fmtRel(latest) || '—'}`
      : '共 0 份备份');

    if (!items.length) {
      host.append(ui.empty({
        icon: '📭',
        title: '暂无远程备份',
        text: '点区块里的「备份」即可把本机配置上传到这里；文件名带时间戳，不会覆盖历史备份。',
      }));
      return;
    }
    const list = el('div', { class: 'wvd-list' });
    for (const it of items) list.append(recordRow(it));
    host.append(list);
  }

  /** 单条记录行：主行文件名（.mono），副行完整时间 + 大小，右侧 [恢复] [删除]。 */
  function recordRow(it) {
    const ts = Number(it.lastModified) || 0;
    const full = ctx.fmtDateTime(ts);
    const nameEl = el('div', { class: 'mono', text: it.name, title: full });
    const metaEl = el('div', { class: 'muted', text: [full, humanSize(it.size)].join(' · ') });
    const restoreBtn = el('button', {
      class: 'btn btn--sm', type: 'button', text: '恢复',
      on: { click: () => doRestore(it) },
    });
    const delBtn = el('button', {
      class: 'btn btn--sm btn--danger', type: 'button', text: '删除',
      on: { click: () => doDelete(it) },
    });
    return el('div', { class: 'row row--between wvd-item' }, [
      el('div', { style: 'min-width:0' }, [nameEl, metaEl]),
      el('div', { class: 'row wvd-item__ops' }, [restoreBtn, delBtn]),
    ]);
  }

  /**
   * 恢复：危险确认 → 任务流。
   * 注：ui.confirmDialog 会顶掉当前记录弹窗（同屏单例）——取消即保持关闭、无副作用；
   * 任务结束后（ok / fail / cancelled 任一）统一重开记录弹窗刷新列表，保证两种操作行为一致。
   */
  async function doRestore(it) {
    const ok = await ui.confirmDialog({
      title: '从 WebDAV 恢复备份',
      confirmLabel: '确认恢复',
      body: el('div', {}, [
        el('p', { class: 'muted', text: `将从远程下载「${it.name}」并覆盖本机配置：MacKit 设置、代理端口/镜像、Git 全局配置、GitHub 凭据（钥匙串）、Rime 自定义配置，完成后自动重新部署输入法。` }),
        el('div', { class: 'err-box section', text: '⚠ 将覆盖本机配置，且不可撤销。' }),
      ]),
    });
    if (!ok) return;
    const t = await ctx.runTask('backup', 'webdav_restore', { name: it.name }, { confirm: true });
    if (t === null) return; // 已有任务在运行，runTask 内部已 toast
    if (t.status === 'ok') ui.toast('ok', `已从 WebDAV 恢复「${it.name}」`);
    else if (t.status === 'cancelled') ui.toast('warn', '恢复已取消');
    else ui.toast('err', '恢复失败，请查看日志');
    // 记录弹窗已被危险确认顶掉（同屏单例）→ 重新打开，拉取最新列表与统计行
    openRecordsModal(ctx);
  }

  /** 删除：危险确认 → 任务流 → 任务结束后重开记录弹窗刷新列表与统计行。 */
  async function doDelete(it) {
    const ok = await ui.confirmDialog({
      title: '删除远程备份',
      confirmLabel: '确认删除',
      body: el('div', {}, [
        el('p', { class: 'muted', text: `将删除 WebDAV 服务器上的「${it.name}」。` }),
        el('div', { class: 'err-box section', text: '⚠ 此操作不可撤销。' }),
      ]),
    });
    if (!ok) return;
    const t = await ctx.runTask('backup', 'webdav_delete', { name: it.name }, { confirm: true });
    if (t === null) return; // 已有任务在运行，runTask 内部已 toast
    if (t.status === 'ok') ui.toast('ok', `已删除「${it.name}」`);
    else if (t.status === 'cancelled') ui.toast('warn', '删除已取消');
    else ui.toast('err', '删除失败，请查看日志');
    // 记录弹窗已被危险确认顶掉（同屏单例）→ 重新打开，拉取最新列表与统计行
    openRecordsModal(ctx);
  }

  ui.modal({ title: 'WebDAV 备份记录', body });
  load();
}

/**
 * 弹窗 B：WebDAV 设置。
 * @param {object} ctx
 */
export function openSettingsModal(ctx) {
  const { el, ui, api } = ctx;

  const bodyHost = el('div');
  const statusEl = el('div', { class: 'muted section' });
  let form = null;
  let saving = false;

  const setStatus = (text) => { statusEl.textContent = text || ''; };

  function renderForm(cfg) {
    bodyHost.innerHTML = '';
    const urlInput = el('input', {
      type: 'text', placeholder: 'https://nas.example.com/dav/',
      value: cfg.url || '', autocomplete: 'off',
    });
    const userInput = el('input', {
      type: 'text', placeholder: '（可选）用户名', value: cfg.username || '', autocomplete: 'off',
    });
    // 密码绝不回填：已保存过则留空 + 占位文案
    const passInput = el('input', {
      type: 'password', value: '', autocomplete: 'new-password',
      placeholder: cfg.hasPassword ? '已保存，如需修改请输入新密码' : '（未设置）',
    });
    const toggleBtn = el('button', {
      class: 'btn btn--sm', type: 'button', text: '显示',
      on: {
        click: () => {
          const show = passInput.type === 'password';
          passInput.type = show ? 'text' : 'password';
          toggleBtn.textContent = show ? '隐藏' : '显示';
        },
      },
    });
    const tlsChk = el('input', { type: 'checkbox', checked: !!cfg.allowInsecureTLS });

    // http://（明文）实时告警
    const httpWarn = el('div');
    const refreshHttpWarn = () => {
      httpWarn.innerHTML = '';
      if (/^http:\/\//i.test(urlInput.value.trim())) {
        httpWarn.append(el('div', { class: 'warn-box section', text: '未加密：凭据将以 Base64 明文传输，建议改用 https。' }));
      }
    };
    urlInput.addEventListener('input', refreshHttpWarn);

    bodyHost.append(
      el('div', { class: 'field' }, [
        el('label', { class: 'muted', text: '服务器地址（WebDAV 根目录 URL）' }),
        urlInput,
      ]),
      httpWarn,
      el('div', { class: 'field' }, [
        el('label', { class: 'muted', text: '用户名' }),
        userInput,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'muted', text: '密码' }),
        el('div', { class: 'field__row' }, [passInput, toggleBtn]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'check' }, [
          tlsChk,
          el('span', { text: '允许自签名证书（不校验证书）' }),
        ]),
        el('div', { class: 'muted', text: '勾选后将不校验证书，存在中间人风险；仅在自建 NAS 使用自签名证书时启用。' }),
      ]),
      el('div', { class: 'muted', text: '备份会存到该地址下的 MacKit/ 目录；保存后会自动做一次连通性探测。' }),
    );

    form = { urlInput, userInput, passInput, tlsChk };
    refreshHttpWarn();
  }

  async function load() {
    bodyHost.innerHTML = '';
    bodyHost.append(el('div', { class: 'view-loading', text: '正在读取 WebDAV 配置…' }));
    try {
      const cfg = await api('GET', '/api/webdav/config');
      if (!bodyHost.isConnected) return; // 竞态：用户已关闭弹窗
      renderForm(cfg || {});
    } catch (err) {
      if (!bodyHost.isConnected) return;
      bodyHost.innerHTML = '';
      bodyHost.append(el('div', { class: 'err-box', text: `读取配置失败：${err.message || err}` }));
    }
  }

  async function save() {
    if (saving || !form) return;
    saving = true;
    setStatus('正在保存…');

    // 只发送用户实际填写的字段：密码留空则不带 password（保持原密码不变）
    const patch = {
      url: form.urlInput.value.trim(),
      username: form.userInput.value,
      allowInsecureTLS: form.tlsChk.checked,
    };
    const pwd = form.passInput.value;
    if (pwd) patch.password = pwd;

    try {
      await api('PUT', '/api/webdav/config', patch);
    } catch (err) {
      setStatus('');
      ui.toast('err', err.message || '保存失败');
      saving = false;
      return;
    }

    if (pwd) {
      // 已保存则清空输入框，绝不把密码留在 DOM 里
      form.passInput.value = '';
      form.passInput.placeholder = '已保存，如需修改请输入新密码';
    }

    // 保存成功后自动做一次连通性探测（无「测试连接」按钮）
    setStatus('正在探测连接…');
    try {
      await api('GET', '/api/webdav/backups');
      if (bodyHost.isConnected) setStatus('已保存 · 连接正常');
      ui.toast('ok', '已保存，连接正常');
    } catch (err) {
      if (bodyHost.isConnected) setStatus('');
      ui.toast('err', err.message || '已保存，但连接失败');
    }
    saving = false;
  }

  ui.modal({
    title: 'WebDAV 设置',
    body: el('div', {}, [bodyHost, statusEl]),
    actions: [
      { label: '取消', kind: 'ghost' },
      { label: '保存', kind: 'primary', onClick: () => { save(); } },
    ],
  });
  load();
}

export default { buildWebdavSection, openRecordsModal, openSettingsModal };
