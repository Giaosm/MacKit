/**
 * MacKit · LibreTV（视图）
 *
 * 界面职责**只有托管**：官方 Next.js standalone 包的安装 / 启停 / 更新 / 卸载、看状态、看日志。
 * 站内的点播源、直播源、观看记录全在 LibreTV 自己的进程与浏览器本地存储里
 * （见 lib/libretv.js 头部：本应用不内置、不分发任何源）。
 *
 * 设计要点（与 views/ysp.js 同一套约定）：
 *   - 状态单一来源 GET /api/libretv/status，前端不推断；5s 轮询（后端有 2s 缓存）。
 *   - 起停 / 安装 / 更新走任务流（ctx.runTask）—— 下载 9MB、等端口就绪这类步骤有进度日志，
 *     也不会让界面看起来卡死。
 *   - 卡片结构建一次，轮询只改文本与按钮禁用态（整块重建会让日志区滚动位置乱跳）。
 *   - 端口有响应但 pid 不是我们的 → 如实标注「不是 MacKit 启动的」并禁用停止，绝不盲杀。
 *   - 访问密码以明文展示：它就是给用户抄到浏览器里用的，隐藏反而没法用。
 */

/** 状态轮询间隔（本地进程，5s 足够） */
const POLL_MS = 5_000;

/** 模块级定时器：切换视图时由 unmount 清掉 */
let pollTimer = null;

/** 运行时长 → `1 小时 23 分` / `3 分 12 秒` */
function fmtDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '—';
  const s = Math.floor(n);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

export default {
  id: 'libretv',
  title: 'LibreTV',

  mount(root, ctx) {
    const { el, ui, api } = ctx;

    /**
     * 本地状态：最近一次 status / 日志文本 / 上游版本 / 是否正在提交任务。
     * dirty = 用户正在编辑设置区（5s 轮询不得把输入框里的字清掉）。
     */
    const st = { data: null, logText: '', latest: null, busy: false, checking: false, dirty: { pw: false, port: false, lan: false } };

    const head = el('div', { class: 'view-head' });
    const body = el('div');
    root.append(head, body);

    head.append(
      el('div', {}, [
        el('h1', { text: 'LibreTV' }),
        el('div', { class: 'muted', text: '本地影视聚合站：下载官方 Next.js standalone 预构建包并以子进程常驻，默认只绑 127.0.0.1。程序本身不含任何点播 / 直播源。' }),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn--sm', type: 'button', text: '刷新状态', on: { click: () => refresh(true, true) } }),
      ]),
    );

    // ======================= ① 服务状态卡 =======================
    const lamp = el('span', { class: 'light light--warn', title: '读取中' });
    const val = {};
    /**
     * 紧凑数据块：小标签在上、值在下。
     * 不用 `.kv`（一行一条、标签在左值在右）—— 卡片有 1100px 宽，那样每行中间全是空白，
     * 六条数据就撑出半屏。这里改成 3 列网格，一屏能看完。
     */
    const mkStat = (key, label) => {
      const v = el('div', { style: 'font-weight:600; font-size:14px; line-height:1.35; word-break:break-all' });
      val[key] = v;
      return el('div', {}, [
        el('div', { class: 'muted', style: 'font-size:11px; letter-spacing:.6px; margin-bottom:1px', text: label }),
        v,
      ]);
    };
    const statGrid = el('div', {
      style: 'display:grid; grid-template-columns:repeat(auto-fit, minmax(148px, 1fr)); gap:var(--space-3) var(--space-4); margin-top:var(--space-2)',
    }, [
      mkStat('state', '状态'),
      mkStat('version', '已装版本'),
      mkStat('upstream', '上游版本'),
      mkStat('port', '端口'),
      mkStat('pid', '进程'),
      mkStat('uptime', '已运行'),
    ]);

    /** 一行「标签 + 值 + 按钮」：标签定宽，左侧对齐，避免像 .kv 那样被拉到两边 */
    const lineRow = (label, kids, extra) => el('div', { class: 'row', style: 'gap:var(--space-2)' }, [
      el('span', { class: 'muted nowrap', style: 'width:60px; flex:none', text: label }),
      ...kids,
      extra || null,
    ]);
    const divider = () => el('div', { style: 'height:1px; background:var(--border); margin:var(--space-3) 0' });

    /** 访问密码（明文 + 复制） */
    const pwText = el('code', { class: 'mono', text: '—' });
    const pwReq = el('span', { class: 'muted', style: 'font-size:12px', text: '—' });
    const btnCopyPw = el('button', {
      class: 'btn btn--sm', type: 'button', text: '复制',
      on: { click: () => ui.copy(st.data && st.data.password, '已复制访问密码') },
    });
    /** 访问地址（复制 / 打开） */
    const urlText = el('code', { class: 'mono', text: '—' });
    const btnCopyUrl = el('button', {
      class: 'btn btn--sm', type: 'button', text: '复制',
      on: { click: () => ui.copy(st.data && st.data.url, '已复制访问地址') },
    });
    const btnOpen = el('button', {
      class: 'btn btn--sm btn--primary', type: 'button', text: '在浏览器打开',
      on: { click: () => openSite() },
    });

    /** 路径信息：12px 灰字单行一条，放在卡片底部，不占主视觉 */
    const dirText = el('span', { class: 'mono', text: '—' });
    const logText = el('span', { class: 'mono', text: '—' });
    const nodeText = el('span', { class: 'mono', text: '—' });
    const detailLine = (label, node) => el('div', { style: 'display:flex; gap:var(--space-2); word-break:break-all' }, [
      el('span', { class: 'muted nowrap', style: 'width:60px; flex:none', text: label }),
      node,
    ]);

    const btnInstall = el('button', { class: 'btn btn--primary', type: 'button', text: '安装', on: { click: () => doAction('install') } });
    const btnStart = el('button', { class: 'btn btn--primary', type: 'button', text: '启动', on: { click: () => doAction('start') } });
    const btnStop = el('button', { class: 'btn', type: 'button', text: '停止', on: { click: () => doAction('stop') } });
    const btnRestart = el('button', { class: 'btn', type: 'button', text: '重启', on: { click: () => doAction('restart') } });
    const btnUpdate = el('button', { class: 'btn', type: 'button', text: '更新', on: { click: () => doAction('update') } });
    const btnUninstall = el('button', { class: 'btn btn--danger', type: 'button', text: '卸载', on: { click: () => doAction('uninstall') } });
    const btnCheck = el('button', { class: 'btn btn--sm', type: 'button', text: '检查更新', on: { click: () => checkLatest(true) } });

    const note = el('div', { class: 'warn-box', style: 'margin-top:var(--space-3)', hidden: true });

    const statusCard = el('div', { class: 'card section' }, [
      el('div', { class: 'card__head' }, [
        el('div', { class: 'card__title' }, [lamp, '① 服务状态']),
        btnCheck,
      ]),
      statGrid,
      divider(),
      lineRow('访问密码', [pwText, btnCopyPw], pwReq),
      el('div', { style: 'height:var(--space-2)' }),
      lineRow('访问地址', [urlText, btnCopyUrl, btnOpen]),
      divider(),
      el('div', { class: 'muted', style: 'font-size:12px; line-height:1.9' }, [
        detailLine('程序目录', dirText),
        detailLine('日志', logText),
        detailLine('node', nodeText),
      ]),
      note,
      el('div', { class: 'row', style: 'margin-top:var(--space-4)' }, [
        btnInstall, btnStart, btnStop, btnRestart, btnUpdate,
        el('span', { class: 'grow' }),
        btnUninstall,
      ]),
      el('div', { class: 'muted', style: 'margin-top:var(--space-3); font-size:12px', text: '独立于 MacKit 运行：关闭 / 重启界面的不会中断正在播放的视频。卸载只删程序目录，浏览器里的观看记录不受影响。' }),
    ]);

    // ======================= ② 访问设置卡 =======================
    const pwInput = el('input', {
      type: 'text', placeholder: '留空则不修改；至少 6 位', style: 'flex:1; min-width:160px',
      on: {
        input: () => { st.dirty.pw = true; },
        keydown: (e) => { if (e.key === 'Enter') saveConfig(); },
      },
    });
    const btnRandomPw = el('button', {
      class: 'btn btn--sm nowrap', type: 'button', text: '随机重置',
      title: '生成一个 14 位随机密码并清空输入框',
      on: { click: () => resetPassword() },
    });
    const portInput = el('input', {
      type: 'number', min: '1024', max: '65535', step: '1', style: 'width:120px',
      on: {
        input: () => { st.dirty.port = true; },
        keydown: (e) => { if (e.key === 'Enter') saveConfig(); },
      },
    });
    const lanCheck = el('input', {
      type: 'checkbox',
      on: { change: () => { st.dirty.lan = true; paintLanHint(); } },
    });
    const lanHint = el('div', { class: 'warn-box', style: 'margin-top:var(--space-3)', hidden: true, text: '开启后 LibreTV 会监听 0.0.0.0：同网段（同一 Wi-Fi / 交换机）的任何设备都能打开它，只靠访问密码把门。在公共网络里不要开。' });
    const btnSave = el('button', { class: 'btn btn--primary', type: 'button', text: '保存设置', on: { click: () => saveConfig() } });

    /** 表单项：标签在上、控件在下（比「标签左 + 控件右」省掉一整行宽度） */
    const mkField = (label, body, hint) => el('div', { class: 'field', style: 'margin:0' }, [
      el('span', { class: 'muted', style: 'font-size:12px', text: label }),
      body,
      hint ? el('span', { class: 'muted', style: 'font-size:11px', text: hint }) : null,
    ]);

    const configCard = el('div', { class: 'card section' }, [
      el('div', { class: 'card__head' }, [
        el('div', { class: 'card__title', text: '② 访问设置' }),
        el('div', { class: 'muted', style: 'font-size:12px', text: '写入 ~/.mackit/libretv/state.json' }),
      ]),
      el('div', {
        style: 'display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr); gap:var(--space-4) var(--space-5); align-items:start',
      }, [
        mkField('访问密码', el('div', { class: 'row', style: 'gap:var(--space-2); flex-wrap:nowrap' }, [pwInput, btnRandomPw])),
        mkField('端口', el('div', { class: 'row', style: 'gap:var(--space-2)' }, [portInput]),
          '1024–65535；被占用时启动会自动顺延'),
        el('div', { style: 'grid-column:1 / -1' }, [
          el('div', { class: 'row' }, [
            el('label', { class: 'check' }, [lanCheck, el('span', { text: '允许局域网访问' })]),
            el('span', { class: 'muted', style: 'font-size:12px', text: '默认关闭，只监听 127.0.0.1' }),
            el('span', { class: 'grow' }),
            el('span', { class: 'muted', style: 'font-size:12px', text: '运行中修改后需点「重启」生效' }),
          ]),
          lanHint,
        ]),
      ]),
      el('div', { class: 'row', style: 'margin-top:var(--space-4)' }, [btnSave]),
    ]);

    // ======================= ③ 日志卡 =======================
    const logBox = el('div', {
      class: 'diff',
      style: 'max-height:340px; overflow:auto; white-space:pre-wrap; line-height:1.55',
      text: '（暂无日志）',
    });
    const logCard = el('div', { class: 'card section' }, [
      el('div', { class: 'card__head' }, [
        el('div', { class: 'card__title', text: '③ 运行日志' }),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn--sm', type: 'button', text: '刷新日志', on: { click: () => refreshLogs(true) } }),
        ]),
      ]),
      logBox,
      el('div', { class: 'muted', text: 'server.js 的 stdout / stderr（Next.js 启动信息、请求错误等），保留在 ~/.mackit/libretv/libretv.log。' }),
    ]);

    // ======================= 渲染 =======================
    function paintLanHint() {
      lanHint.hidden = !lanCheck.checked;
    }

    function paintLatest() {
      const L = st.latest;
      if (!L) { val.upstream.textContent = '—'; return; }
      if (L.error) { val.upstream.textContent = `检查失败：${L.error}`; return; }
      const up = L.upToDate === null ? '' : (L.upToDate ? '（已是最新）' : '（可更新）');
      val.upstream.textContent = `v${L.version}${up}`;
    }

    function paint(s) {
      st.data = s;
      let level = 'warn';
      let lampTitle = '未安装';
      if (!s.installed) { level = 'warn'; lampTitle = '未安装'; }
      else if (s.running) { level = s.managed ? 'ok' : 'warn'; lampTitle = s.managed ? '运行中' : '运行中（非本应用实例）'; }
      else { level = 'warn'; lampTitle = '未启动'; }
      lamp.className = `light light--${level}`;
      lamp.title = lampTitle;

      if (!s.installed) val.state.textContent = '未安装';
      else if (!s.running) val.state.textContent = '未启动';
      else if (s.managed) val.state.textContent = '运行中';
      else val.state.textContent = '运行中（不是 MacKit 启动的实例）';

      val.version.textContent = s.version ? `v${s.version}${s.versionMismatch ? '（与记录不一致，建议重启）' : ''}` : '—';
      val.port.textContent = `${s.port}${s.port === s.defaultPort ? '（默认）' : ''}`;
      val.pid.textContent = s.pid ? String(s.pid) : (s.foreign ? '未知（非本应用拉起）' : '—');
      val.uptime.textContent = s.pid && s.startedAt ? fmtDuration((Date.now() - s.startedAt) / 1000) : '—';

      if (s.passwordRequired === null) pwReq.textContent = '—';
      else if (s.passwordRequired) pwReq.textContent = s.serverVersion ? `服务端要求密码（v${s.serverVersion}）` : '服务端要求密码';
      else pwReq.textContent = '服务端未启用密码';

      pwText.textContent = s.password || '—';
      btnCopyPw.disabled = !s.password;

      urlText.textContent = s.lan ? `${s.url}（本机）` : s.url;
      urlText.title = s.lanUrl ? `局域网：${s.lanUrl}` : '';
      btnOpen.disabled = !s.running;

      dirText.textContent = s.dir || '未安装（点「安装」下载官方包）';
      logText.textContent = s.logFile;
      nodeText.textContent = s.node.exists ? s.node.bin : `${s.node.bin}（缺失）`;

      // 按钮
      btnInstall.disabled = st.busy;
      btnInstall.classList.toggle('btn--primary', !s.installed);
      btnStart.disabled = st.busy || s.running || !s.installed;
      btnStop.disabled = st.busy || !s.running || !s.managed;
      btnRestart.disabled = st.busy || !s.installed;
      btnUpdate.disabled = st.busy || !s.installed;
      btnUninstall.disabled = st.busy || (!s.installed && !s.running);
      btnCheck.disabled = st.busy || st.checking;
      btnCheck.textContent = st.checking ? '检查中…' : '检查更新';

      // 设置区：只在用户没动过的字段上回填，避免 5s 轮询把正在敲的字清掉 / 把勾选弹回去
      if (!st.dirty.pw) pwInput.value = '';
      pwInput.placeholder = s.password ? '留空则不修改；至少 6 位' : '留空则自动生成随机密码';
      if (!st.dirty.port) portInput.value = String(s.port);
      if (!st.dirty.lan) lanCheck.checked = !!s.lan;
      paintLanHint();

      // 提示条：优先级「非本应用实例」>「未安装 node」>「局域网已开」
      let text = '';
      if (s.foreign) {
        text = `端口 ${s.port} 上有服务在响应，但它不是 MacKit 启动的（没有记录的 pid）—— 本页只负责展示，不会去停它。`;
      } else if (!s.node.exists) {
        text = `未找到 node（期望路径 ${s.node.bin}）：LibreTV 是 Node 程序，装一个 node 后才能启动。`;
      } else if (s.running && s.lan) {
        text = `局域网访问已开启：同网段设备可用 ${s.lanUrl || `http://<本机IP>:${s.port}/`} 打开（只靠访问密码保护）。`;
      }
      note.hidden = !text;
      note.textContent = text;

      paintLatest();
    }

    // ======================= 数据 =======================
    /**
     * @param {boolean} [showToast] 手动刷新时给可见反馈
     * @param {boolean} [force] 绕过后端 2s 缓存（启停 / 手动刷新必须带）
     */
    async function refresh(showToast, force) {
      try {
        const s = await api('GET', `/api/libretv/status${force ? '?force=1' : ''}`);
        paint(s);
        if (showToast) ui.toast('ok', '状态已刷新');
      } catch (err) {
        if (showToast) ui.toast('err', err.message || '读取状态失败');
        else lamp.className = 'light light--error';
      }
    }

    async function refreshLogs(showToast) {
      try {
        const r = await api('GET', '/api/libretv/logs?lines=120');
        const text = r.text || '（暂无日志）';
        if (text !== st.logText) {
          st.logText = text;
          // 只在用户本来就贴着底部时才跟随到底，避免打断往上翻看
          const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
          logBox.textContent = text;
          if (atBottom) logBox.scrollTop = logBox.scrollHeight;
        }
        if (showToast) {
          if (r.text) ui.toast('ok', '日志已刷新');
          else if (r.exists) ui.toast('warn', '日志文件是空的（服务还没写过东西）');
          else ui.toast('warn', '还没有日志文件（服务还没启动过）');
        }
      } catch (err) {
        if (showToast) ui.toast('err', err.message || '读取日志失败');
      }
    }

    /** 查上游最新版本（会真的联网，只在挂载与手动点击时跑） */
    async function checkLatest(showToast) {
      if (st.checking) return;
      st.checking = true;
      if (st.data) paint(st.data);
      try {
        const r = await api('GET', '/api/libretv/latest');
        st.latest = r;
        if (st.data) paint(st.data);
        if (showToast) {
          if (r.error) ui.toast('warn', `检查更新失败：${r.error}`);
          else if (r.upToDate) ui.toast('ok', `已是最新版本 v${r.version}`);
          else ui.toast('warn', `有新版本 v${r.version}，点「更新」升级`);
        }
      } catch (err) {
        if (showToast) ui.toast('err', err.message || '检查更新失败');
      } finally {
        st.checking = false;
        if (st.data) paint(st.data);
      }
    }

    function openSite() {
      const url = st.data && st.data.url;
      if (!url) return;
      if (!st.data.running) { ui.toast('warn', '服务未启动，请先点「启动」'); return; }
      window.open(url, '_blank', 'noopener');
    }

    // ======================= 设置 =======================
    async function saveConfig() {
      if (st.busy) return;
      const params = {};
      const pw = pwInput.value.trim();
      if (pw) {
        if (pw.length < 6) { ui.toast('warn', '访问密码至少 6 位'); return; }
        params.password = pw;
      }
      const portStr = portInput.value.trim();
      if (portStr && portStr !== String(st.data ? st.data.port : '')) {
        if (!ui.portOk(portStr) || Number(portStr) < 1024) { ui.toast('warn', '端口需为 1024–65535 的整数'); return; }
        params.port = Number(portStr);
      }
      const lan = !!lanCheck.checked;
      if (!st.data || lan !== !!st.data.lan) params.lan = lan;
      if (Object.keys(params).length === 0) { ui.toast('warn', '没有需要保存的改动'); return; }

      if (params.lan === true) {
        const go = await ui.confirmDialog({
          title: '允许局域网访问？',
          body: el('div', {}, [
            el('p', { text: '开启后 LibreTV 会监听 0.0.0.0，同网段（同一 Wi-Fi / 交换机）的任何设备都能打开它。' }),
            el('p', { class: 'muted', text: '唯一的一道门是访问密码。在公共网络（咖啡厅、酒店、公司访客网）里不要开。' }),
          ]),
          confirmLabel: '仍然开启',
        });
        if (!go) return;
      }
      await submit('configure', params);
    }

    async function resetPassword() {
      if (st.busy) return;
      const ok = await ui.confirmDialog({
        title: '生成新的访问密码？',
        body: el('div', {}, [
          el('p', { text: '会立刻换成一个新的 14 位随机密码，已登录的浏览器需要重新输入。' }),
          el('p', { class: 'muted', text: '服务正在运行时，改动要重启后才生效。' }),
        ]),
        confirmLabel: '重置',
      });
      if (!ok) return;
      await submit('configure', { password: '' });
    }

    // ======================= 动作 =======================
    const ACTION_TEXT = {
      install: { title: '安装 LibreTV？', body: '会从 GitHub 下载官方 standalone 包（约 9MB）并解压到 ~/.mackit/libretv/。下载走模块通道，直连很慢时请切「优先代理」。', confirmLabel: '安装' },
      start: null,
      stop: { title: '停止 LibreTV？', body: '正在播放的页面会立刻断开，需要重新打开。', confirmLabel: '停止' },
      restart: { title: '重启 LibreTV？', body: '服务会中断几秒，浏览器里的页面需要刷新。', confirmLabel: '重启' },
      update: { title: '更新 LibreTV？', body: '会下载上游最新版本并切换过去；新版本启动失败时自动回滚到当前版本，成功后清理旧版本目录。', confirmLabel: '更新' },
      uninstall: { title: '卸载 LibreTV？', body: '会停止服务并删除 ~/.mackit/libretv/（程序本体 + 配置 + 日志）。浏览器里的观看记录不受影响。', confirmLabel: '卸载', danger: true },
    };

    async function doAction(action) {
      if (st.busy) return;
      const spec = ACTION_TEXT[action];
      if (spec) {
        const ok = await ui.confirmDialog({
          title: spec.title,
          body: el('div', {}, [el('p', { text: spec.body })]),
          confirmLabel: spec.confirmLabel,
        });
        if (!ok) return;
      }
      await submit(action, {});
    }

    /** 提交任务并维护本地忙碌态（任务结束由 'done' 订阅刷新） */
    async function submit(action, params) {
      st.busy = true;
      if (st.data) paint(st.data);
      try {
        const t = await ctx.runTask('libretv', action, params, { confirm: action === 'uninstall' });
        // 成功才清掉「正在编辑」标记：失败时用户填的值要留着让他改
        if (t && t.status === 'ok') { st.dirty.pw = false; st.dirty.port = false; st.dirty.lan = false; }
      } catch { /* runTask 内部已 toast */ }
      finally {
        st.busy = false;
        if (st.data) paint(st.data);
      }
    }

    // ======================= 装配 =======================
    body.append(statusCard, configCard, logCard);

    // 任务结束后刷新（安装 / 更新会改版本，启停会改运行态，configure 会改配置回显）
    ctx.on('done', (t) => {
      if (t && t.module === 'libretv') { refresh(false, true); refreshLogs(false); }
    });

    refresh(false);
    refreshLogs(false);
    checkLatest(false);
    // 同一个视图可能被反复 mount（切走再切回）：先清掉上一轮定时器，避免叠加轮询
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    pollTimer = setInterval(() => {
      if (document.hidden) return;   // 标签页在后台就没必要每 5s 打一次
      refresh(false);
      refreshLogs(false);
    }, POLL_MS);
  },

  unmount() {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  },
};
