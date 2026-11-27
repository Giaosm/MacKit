/**
 * MacKit · LibreTV（视图）
 *
 * 界面职责**只有托管**：官方 Next.js standalone 包的安装 / 启停 / 更新 / 卸载、看状态、看日志。
 * 站内的点播源、直播源、观看记录全在 LibreTV 自己的进程与浏览器本地存储里
 * （见 lib/libretv.js 头部：本应用不内置、不分发任何源）。
 *
 * 设计要点：
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

/**
 * 上游版本结论（跨 mount 复用）：进页面要看得到「有没有新版」，但每次切页都联网没必要，
 * 5 分钟内直接复用它；点「检查更新」时强制重查。
 */
let latestCache = { at: 0, value: null };
const LATEST_TTL_MS = 5 * 60_000;

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
    const st = { data: null, logText: '', latest: null, busy: false, checking: false, dirty: { port: false, lan: false } };

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
      const v = el('div', { class: 'stat__v' });
      val[key] = v;
      return el('div', {}, [
        el('div', { class: 'stat__k', text: label }),
        v,
      ]);
    };
    const statGrid = el('div', {
      class: 'stat-grid', style: '--stat-min:148px; margin-top:var(--space-2)',
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

    /**
     * 访问密码：查看态（明文 + 复制 + 更改）/ 编辑态（输入框 + 复制 + 确定）。
     * 编辑态下 5s 轮询只改被隐藏的 pwText，绝不碰 pwEdit.value —— 否则正敲的字会被冲掉。
     */
    let pwEditing = false;
    const pwText = el('code', { class: 'mono', text: '—' });
    const pwEdit = el('input', {
      type: 'text', class: 'mono', style: 'flex:1; min-width:160px; display:none',
      on: {
        keydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitPassword(); }
          else if (e.key === 'Escape') { e.preventDefault(); exitPwEdit(); }
        },
      },
    });
    const btnCopyPw = el('button', {
      class: 'btn btn--sm', type: 'button', text: '复制',
      on: { click: () => ui.copy(st.data && st.data.password, '已复制访问密码') },
    });
    const btnEditPw = el('button', {
      class: 'btn btn--sm', type: 'button', text: '更改',
      on: { click: () => (pwEditing ? commitPassword() : enterPwEdit()) },
    });
    const btnRandomPw = el('button', {
      class: 'btn btn--sm nowrap', type: 'button', text: '随机', style: 'display:none',
      title: '填入一个 14 位随机密码，点「确定」后生效',
      on: { click: () => { pwEdit.value = genPw(); pwEdit.focus(); } },
    });
    const btnCancelPw = el('button', {
      class: 'btn btn--sm', type: 'button', text: '取消', style: 'display:none',
      title: '放弃这次修改（Esc）',
      on: { click: () => exitPwEdit() },
    });

    /** 14 位随机密码：字符集与后端 genPassword 一致（去掉 0/O/1/l/I 等易混字符） */
    function genPw() {
      const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const bytes = new Uint8Array(14);
      crypto.getRandomValues(bytes);
      let out = '';
      for (let i = 0; i < 14; i += 1) out += alphabet[bytes[i] % alphabet.length];
      return out;
    }

    function applyPwMode() {
      pwText.style.display = pwEditing ? 'none' : '';
      pwEdit.style.display = pwEditing ? '' : 'none';
      btnRandomPw.style.display = pwEditing ? '' : 'none';
      btnCancelPw.style.display = pwEditing ? '' : 'none';
      btnEditPw.textContent = pwEditing ? '确定' : '更改';
    }

    /** 进入编辑：预填当前密码，全选，直接敲就是覆盖。没有密码时不允许进入（按钮本身已禁用） */
    function enterPwEdit() {
      if (pwEditing || !st.data || !st.data.password) return;
      pwEditing = true;
      pwEdit.value = st.data.password;
      applyPwMode();
      pwEdit.focus();
      pwEdit.select();
    }

    function exitPwEdit() {
      pwEditing = false;
      pwEdit.value = '';
      applyPwMode();
      if (st.data) paint(st.data);
    }

    /**
     * 确定：校验 6 位 → 写入配置 → 运行中且是本应用拉起的实例就顺手重启。
     * 只写 state.json 不重启等于没改（进程还拿旧密码，复制新密码去登录必然失败），所以一并重启。
     */
    async function commitPassword() {
      if (st.busy || !pwEditing) return;
      const next = pwEdit.value.trim();
      if (next.length < 6) { ui.toast('warn', '访问密码至少 6 位'); pwEdit.focus(); return; }
      const s = st.data || {};
      if (next === (s.password || '')) { exitPwEdit(); ui.toast('warn', '密码未变化'); return; }

      // 失败时保持编辑态：用户填的值要留着让他改
      if (!(await submit('configure', { password: next }))) return;
      if (s.running && s.managed) {
        const restarted = await submit('restart', {});
        exitPwEdit();
        await refresh(false, true);
        if (restarted) ui.toast('ok', '密码已更新，服务已重启生效');
        return;
      }
      exitPwEdit();
      await refresh(false, true);
      ui.toast('ok', s.running ? '密码已保存；当前实例不是 MacKit 启动的，需手动重启才生效' : '密码已更新，下次启动生效');
    }
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
    /** 局域网地址：独立一行（只在开启局域网后出现），可选中 / 可复制，不靠悬停提示 */
    const lanUrlText = el('code', { class: 'mono', text: '—' });
    const btnCopyLan = el('button', {
      class: 'btn btn--sm', type: 'button', text: '复制',
      on: { click: () => ui.copy(st.data && st.data.lanUrl, '已复制局域网地址') },
    });
    const lanRow = el('div', { hidden: true, style: 'margin-top:var(--space-2)' }, [lineRow('局域网', [lanUrlText, btnCopyLan])]);

    /** 路径信息：12px 灰字单行一条，放在卡片底部，不占主视觉 */
    const dirText = el('span', { class: 'mono', text: '—' });
    const logText = el('span', { class: 'mono', text: '—' });
    const nodeText = el('span', { class: 'mono', text: '—' });
    const detailLine = (label, node) => el('div', { class: 'detail-line' }, [
      el('span', { class: 'detail-line__k', text: label }),
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
      lineRow('访问密码', [pwText, pwEdit, btnRandomPw, btnCopyPw, btnCancelPw, btnEditPw]),
      el('div', { style: 'height:var(--space-2)' }),
      lineRow('访问地址', [urlText, btnCopyUrl, btnOpen]),
      lanRow,
      divider(),
      el('div', { class: 'detail-lines' }, [
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

    // ======================= ② 端口与网络卡 =======================
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

    const configCard = el('div', { class: 'card section' }, [
      el('div', { class: 'card__head' }, [el('div', { class: 'card__title', text: '② 端口与网络' })]),
      lineRow('端口', [
        portInput,
        el('span', { class: 'muted', style: 'font-size:12px', text: '1024–65535；被占用时启动会自动顺延' }),
        el('span', { class: 'grow' }),
        el('label', { class: 'check' }, [lanCheck, el('span', { text: '允许局域网访问' })]),
        btnSave,
      ]),
      lanHint,
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

    /** 有确定的「上游版本且本地已安装」且上游更新 → 才允许点「更新」 */
    function updateState() {
      const L = st.latest;
      const installed = !!(st.data && st.data.installed);
      if (!L) return { ok: false, text: '正在检查上游版本…' };
      if (L.error) return { ok: false, text: `检查失败（${L.error}），可点「检查更新」重试` };
      if (!installed) return { ok: false, text: '请先安装' };
      if (L.upToDate) return { ok: false, text: `已是最新版本 v${L.version}` };
      return { ok: true, text: `可更新到 v${L.version}` };
    }

    function paintLatest() {
      const L = st.latest;
      if (!L) { val.upstream.textContent = st.checking ? '检查中…' : '—'; return; }
      if (L.error) { val.upstream.textContent = '检查失败'; return; }
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
      // 运行中改过端口时，配置端口与实际端口会不一样，两个都写出来
      val.port.textContent = s.restartPending && s.livePort
        ? `${s.port}（待生效，当前 ${s.livePort}）`
        : `${s.port}${s.port === s.defaultPort ? '（默认）' : ''}`;
      val.pid.textContent = s.pid ? String(s.pid) : (s.foreign ? '未知（非本应用拉起）' : '—');
      val.uptime.textContent = s.pid && s.startedAt ? fmtDuration((Date.now() - s.startedAt) / 1000) : '—';

      pwText.textContent = s.password || '—';
      // 编辑态下「复制」仍取旧密码，没意义 → 禁用；「更改」此时是「确定」，保持可点
      btnCopyPw.disabled = !s.password || pwEditing;
      btnCancelPw.disabled = st.busy;
      btnEditPw.disabled = st.busy || !s.password;

      urlText.textContent = s.lan ? `${s.url}（本机）` : s.url;
      btnOpen.disabled = !s.running;

      // 局域网地址独立一行。取不到真实网卡时后端回落 127.0.0.1，
      // 那种地址复制到手机 / 电视上必然打不开 —— 如实说明，并禁用复制。
      const lanHost = (() => {
        try { return s.lanUrl ? new URL(s.lanUrl).hostname : ''; } catch { return ''; }
      })();
      const lanReady = !!(s.lan && lanHost && lanHost !== '127.0.0.1' && lanHost !== 'localhost');
      lanRow.hidden = !s.lan;
      lanUrlText.textContent = lanReady ? s.lanUrl : '未检测到局域网 IP（Wi-Fi / 网线没连上？）';
      btnCopyLan.disabled = !lanReady;

      dirText.textContent = s.dir || '未安装（点「安装」下载官方包）';
      logText.textContent = s.logFile;
      nodeText.textContent = s.node.exists ? s.node.bin : `${s.node.bin}（缺失）`;

      // 按钮
      // 装好了就不该再点「安装」：那一步是下载 + 解压最新官方包，装完再点只会白等一次；
      // 要重装请先卸载（按钮 tooltip 里说清楚）。
      btnInstall.disabled = st.busy || s.installed;
      btnInstall.title = s.installed ? `已安装 v${s.version}；如需重装请先「卸载」` : '下载官方 standalone 包并解压';
      btnInstall.classList.toggle('btn--primary', !s.installed && !st.busy);
      btnStart.disabled = st.busy || s.running || !s.installed;
      btnStop.disabled = st.busy || !s.running || !s.managed;
      btnRestart.disabled = st.busy || !s.installed;
      // 「更新」只在确实存在新版本时可点（上游版本未知 / 检查失败 / 已最新 都禁用）
      const upd = updateState();
      btnUpdate.disabled = st.busy || !upd.ok;
      btnUpdate.title = upd.text;
      btnUninstall.disabled = st.busy || (!s.installed && !s.running);
      btnCheck.disabled = st.busy || st.checking;
      btnCheck.textContent = st.checking ? '检查中…' : '检查更新';

      // 设置区：只在用户没动过的字段上回填，避免 5s 轮询把正在敲的字清掉 / 把勾选弹回去
      if (!st.dirty.port) portInput.value = String(s.port);
      if (!st.dirty.lan) lanCheck.checked = !!s.lan;
      paintLanHint();

      // 提示条：优先级「非本应用实例」>「未安装 node」>「配置待重启」
      // （局域网地址已单独成行，不再在这里重复一遍）
      let text = '';
      if (s.foreign) {
        text = `端口 ${s.livePort || s.port} 上有服务在响应，但它不是 MacKit 启动的（没有记录的 pid）—— 本页只负责展示，不会去停它。`;
      } else if (!s.node.exists) {
        text = `未找到 node（期望路径 ${s.node.bin}）：LibreTV 是 Node 程序，装一个 node 后才能启动。`;
      } else if (s.restartPending) {
        text = `设置已保存但还没生效：当前实例仍运行在端口 ${s.livePort}、仍用旧密码。点「重启」后新端口 / 新密码才生效。`;
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

    /**
     * 查上游最新版本（真的联网）。调用即重查 —— 缓存只用于「切回本页时不必再等一次」，
     * 由 mount 自己判断，不在这里做。
     * @param {boolean} [showToast] 手动点「检查更新」/ 任务结束后给反馈
     */
    async function checkLatest(showToast) {
      if (st.checking) return;
      st.checking = true;
      if (st.data) paint(st.data);
      try {
        const r = await api('GET', '/api/libretv/latest');
        st.latest = r;
        latestCache = { at: Date.now(), value: r };
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

    /** 提交任务并维护本地忙碌态（任务结束由 'done' 订阅刷新）；返回是否成功，供多步流程判断 */
    async function submit(action, params) {
      st.busy = true;
      if (st.data) paint(st.data);
      try {
        const t = await ctx.runTask('libretv', action, params, { confirm: action === 'uninstall' });
        // 成功才清掉「正在编辑」标记：失败时用户填的值要留着让他改
        if (t && t.status === 'ok') {
          st.dirty.port = false; st.dirty.lan = false;
          return true;
        }
        return false;
      } catch {
        // runTask 内部已 toast
        return false;
      } finally {
        st.busy = false;
        if (st.data) paint(st.data);
      }
    }

    // ======================= 装配 =======================
    body.append(statusCard, configCard, logCard);

    // 任务结束后刷新（安装 / 更新会改版本，启停会改运行态，configure 会改配置回显）
    ctx.on('done', (t) => {
      if (!t || t.module !== 'libretv') return;
      refresh(false, true);
      refreshLogs(false);
      // 装完 / 更新完，「是否还有新版」变了 —— 必须重查，否则「更新」按钮的可用态是旧的
      if (t.action === 'install' || t.action === 'update') checkLatest(false);
    });

    refresh(false);
    refreshLogs(false);
    // 进页面就把上游版本展示出来（用户不该为了看一眼版本号先点一次按钮）；
    // 5 分钟内的结论直接复用，切页不会反复联网。
    if (latestCache.value && Date.now() - latestCache.at < LATEST_TTL_MS) {
      st.latest = latestCache.value;
    } else {
      checkLatest(false);
    }
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
