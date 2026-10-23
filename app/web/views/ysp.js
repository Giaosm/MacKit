/**
 * MacKit · 央视频直播（视图）
 *
 * 界面职责很窄：**托管**第三方脚本 ysp-live-vX.Y（Python）—— 起停、看状态、复制订阅地址、看日志。
 * 直播协议、4K/1080p 双引擎、时移回看全在脚本里，前端一行都不重复实现（见 lib/ysp.js 头部）。
 *
 * 设计要点：
 *   - 状态由 GET /api/ysp/status 单一来源给出（运行中 / 未启动 / 不是 MacKit 启动的），
 *     前端不做任何推断；每 5s 轮询一次（后端有 2s 缓存，多标签页不会打爆）。
 *   - 起停走任务流（POST /api/tasks → ctx.runTask）：这样有进度日志、有失败详情，
 *     「等端口就绪」这种最长 30s 的步骤也不会让界面看起来卡死。
 *   - 卡片结构只建一次，轮询只改文本 / 按钮禁用态 —— 整块重建会让日志区滚动位置乱跳。
 *   - 端口上若有响应但 pid 不是 MacKit 记录的，如实标注「不是 MacKit 启动的」并禁用停止，
 *     绝不盲杀别人的进程。
 */

/** 状态轮询间隔（服务是本地进程，5s 足够；后端还有 2s 缓存） */
const POLL_MS = 5_000;

/** 模块级定时器：视图切换时由 unmount 清掉（app.js 会调用默认导出的 unmount） */
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
  id: 'ysp',
  title: '央视频直播',

  mount(root, ctx) {
    const { el, ui, api } = ctx;

    /** 本地状态：最近一次 status / 日志文本 / 是否正在提交任务 */
    const st = { data: null, logText: '', busy: false };

    const head = el('div', { class: 'view-head' });
    const body = el('div');
    root.append(head, body);

    head.append(
      el('div', {}, [
        el('h1', { text: '央视频直播' }),
        el('div', { class: 'muted', text: '托管 ysp-live-vX.Y（第三方 Python 脚本，版本由目录名自动识别）：央视频全频道 4K / 1080p 直播与 7 天时移，输出 m3u 订阅给播放器。' }),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn--sm', type: 'button', text: '刷新状态', on: { click: () => refresh(true, true) } }),
      ]),
    );

    // ======================= ① 服务状态卡（结构建一次，值靠 paint 更新） =======================
    const lamp = el('span', { class: 'light light--warn', title: '读取中' });
    const val = {};
    const mkRow = (key, label) => {
      const v = el('span', { class: 'kv__v' });
      val[key] = v;
      return el('div', { class: 'kv' }, [el('span', { class: 'kv__k', text: label }), v]);
    };
    const btnStart = el('button', { class: 'btn btn--primary', type: 'button', text: '启动', on: { click: () => doAction('start') } });
    const btnStop = el('button', { class: 'btn', type: 'button', text: '停止', on: { click: () => doAction('stop') } });
    const btnRestart = el('button', { class: 'btn', type: 'button', text: '重启', on: { click: () => doAction('restart') } });
    const note = el('div', { class: 'warn-box section', hidden: true });

    const statusCard = el('div', { class: 'card section' }, [
      el('div', { class: 'card__head' }, [
        el('div', { class: 'card__title' }, [lamp, '① 服务状态']),
      ]),
      el('div', { class: 'card__rows' }, [
        mkRow('state', '状态'),
        mkRow('pid', '进程'),
        mkRow('port', '端口'),
        mkRow('version', '版本'),
        mkRow('channels', '频道'),
        mkRow('engine', '高码率协议'),
        mkRow('uptime', '已运行'),
        mkRow('python', 'python3'),
        mkRow('distver', '脚本版本'),
        mkRow('script', '脚本'),
        mkRow('data', '数据目录'),
        mkRow('log', '日志'),
      ]),
      note,
      el('div', { class: 'row section' }, [btnStart, btnStop, btnRestart]),
      el('div', { class: 'muted', text: '直播服务独立于 MacKit 运行：关闭 / 重启 MacKit 界面不会中断正在播放的流；要停就点上面的「停止」。' }),
    ]);

    // ======================= ② 订阅地址卡 =======================
    /** 当前订阅地址（paint 里更新）——复制 / 打开都读它，不从 DOM 文本反读（那里可能是占位的 '—'） */
    let playlistUrl = '';
    const playlistText = el('code', { class: 'mono', text: '—' });
    const btnCopy = el('button', { class: 'btn btn--sm btn--primary', type: 'button', text: '复制', on: { click: () => ui.copy(playlistUrl, '已复制订阅地址') } });
    const btnOpenPlaylist = el('button', { class: 'btn btn--sm', type: 'button', text: '在浏览器打开', on: { click: () => openUrl(playlistUrl) } });
    // 健康检查 / 诊断页是**脚本**提供的：服务没起来时点开只会是连接被拒，所以按钮跟着 running 禁用
    const btnHealth = el('button', { class: 'btn btn--sm', type: 'button', text: '健康检查', on: { click: () => openUrl((st.data && st.data.urls && st.data.urls.health) || '') } });
    const btnDiag = el('button', { class: 'btn btn--sm', type: 'button', text: '诊断日志', on: { click: () => openUrl((st.data && st.data.urls && st.data.urls.diag) || '') } });
    const subCard = el('div', { class: 'card section' }, [
      el('div', { class: 'card__head' }, [el('div', { class: 'card__title', text: '② 订阅地址' })]),
      el('div', { class: 'card__rows' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'muted nowrap', text: '播放器订阅' }),
          playlistText,
          btnCopy, btnOpenPlaylist,
        ]),
        el('div', { class: 'row' }, [btnHealth, btnDiag]),
      ]),
      el('div', { class: 'muted', text: '在 TiviMate / APTV 等播放器里添加上面的 m3u 地址即可。手机 / 电视要拉流时，把 127.0.0.1 换成这台 Mac 的局域网 IP（脚本默认监听 0.0.0.0）。' }),
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
      el('div', { class: 'muted', text: '脚本的 stdout / stderr（含换台、回看、设备配额等诊断信息），保留在 ~/.mackit/ysp.log。' }),
    ]);

    // ======================= 未就绪提示（脚本 / python3 缺失） =======================
    function setupHint(s) {
      const missing = [];
      if (!s.installed) {
        missing.push(el('div', {}, [
          el('div', { text: `未找到直播脚本：${s.root} 下没有 ysp-live-vX.Y 目录` }),
          el('div', { class: 'muted', text: '把作者发布的整个目录解压到上面这个路径（与 app/ 同级，目录名保持原样，里面要有 ysp-live*.py），然后点「刷新状态」。' }),
        ]));
      }
      if (!s.python.exists) {
        missing.push(el('div', {}, [
          el('div', { text: '未检测到 python3' }),
          el('div', { class: 'muted', text: '装一个即可：xcode-select --install（系统自带）或 brew install python。' }),
        ]));
      }
      return missing.length ? el('div', { class: 'err-box section' }, missing) : null;
    }

    // ======================= 渲染 =======================
    function paint(s) {
      st.data = s;
      // 状态灯：脚本 / 解释器缺失优先，其次是运行态
      let level = 'warn';
      let lampTitle = '未启动';
      if (!s.installed) { level = 'error'; lampTitle = '脚本缺失'; }
      else if (!s.python.exists) { level = 'error'; lampTitle = '缺少 python3'; }
      else if (s.running) { level = s.managed ? 'ok' : 'warn'; lampTitle = s.managed ? '运行中' : '运行中（非本应用实例）'; }
      lamp.className = `light light--${level}`;
      lamp.title = lampTitle;

      if (!s.installed) val.state.textContent = '脚本缺失';
      else if (!s.running) val.state.textContent = '未启动';
      else if (s.managed) val.state.textContent = '运行中';
      else val.state.textContent = '运行中（不是 MacKit 启动的实例）';

      if (s.pid) val.pid.textContent = String(s.pid);
      else if (s.foreign) val.pid.textContent = '未知（非本应用拉起）';
      else val.pid.textContent = '—';

      val.port.textContent = String(s.port);
      val.version.textContent = s.version || '—';
      val.channels.textContent = Number.isInteger(s.channels) ? `${s.channels} 路` : '—';

      if (s.deviceReady === null) val.engine.textContent = '—';
      else if (!s.deviceReady) val.engine.textContent = '初始化中（4K 暂回落 1080p）';
      else val.engine.textContent = Number.isInteger(s.deviceSlots) && s.deviceSlots > 0
        ? `就绪（可 4K/8K，设备池 ${s.deviceSlots} 台）`
        : '就绪（可 4K/8K）';

      val.uptime.textContent = s.running ? fmtDuration(s.uptimeSec) : '—';
      val.python.textContent = s.python.exists ? s.python.bin : `${s.python.bin}（缺失）`;
      // 目录是自动发现的（取版本号最大的那份）：把挑中的版本与「被忽略的旧版本」都摊开，
      // 免得用户放了 v9.6 却仍看到 v9.5 在跑时分不清是哪一步没生效。
      const others = Array.isArray(s.otherDists) && s.otherDists.length ? `（忽略旧版：${s.otherDists.join('、')}）` : '';
      val.distver.textContent = `${s.distVersion ? `v${s.distVersion}` : '—'}${others}`;
      val.script.textContent = s.installed ? s.script : `未找到（扫描根目录 ${s.root}）`;
      val.data.textContent = s.dataDir;
      val.log.textContent = s.logFile;

      // 订阅地址：真实地址存进 playlistUrl（复制 / 打开都读它），界面上的 '—' 只是占位
      playlistUrl = (s.urls && s.urls.playlist) || '';
      playlistText.textContent = playlistUrl || '—';
      // 地址本身与运行态无关（先复制存进播放器也合理），但「打开」只对跑着的实例有意义
      btnCopy.disabled = !playlistUrl;
      btnOpenPlaylist.disabled = !s.running;
      btnHealth.disabled = !s.running;
      btnDiag.disabled = !s.running;

      // 按钮
      btnStart.disabled = st.busy || s.running || !s.installed || !s.python.exists;
      btnStop.disabled = st.busy || !s.running || !s.managed;
      btnRestart.disabled = st.busy || !s.managed;

      // 提示条：只会出现一条，优先级「非本应用实例」>「未就绪」
      let text = '';
      if (s.foreign) {
        text = `端口 ${s.port} 上有服务在响应，但它不是 MacKit 启动的（没有记录的 pid）—— 本页只负责展示，不会去停它。`;
      } else if (s.running && s.deviceReady === false) {
        text = '高码率设备协议仍在初始化：4K / 8K 频道暂时回退到 1080p，脚本会自动重试（通常几十秒内就绪）。';
      }
      note.hidden = !text;
      note.textContent = text;

      // 未就绪提示卡（每次重建，内容很短）
      const hint = setupHint(s);
      const old = body.querySelector('.err-box--setup');
      if (old) old.remove();
      if (hint) { hint.classList.add('err-box--setup'); body.insertBefore(hint, body.firstChild); }
    }

    function openUrl(url) {
      if (!url) { ui.toast('warn', '服务未启动，暂无该页面'); return; }
      window.open(url, '_blank', 'noopener');
    }

    // ======================= 数据 =======================
    /**
     * @param {boolean} [showToast] 手动刷新时给可见反馈
     * @param {boolean} [force] 绕过后端 2s 缓存（启停 / 手动刷新必须带）
     */
    async function refresh(showToast, force) {
      try {
        const s = await api('GET', `/api/ysp/status${force ? '?force=1' : ''}`);
        paint(s);
        if (showToast) ui.toast('ok', '状态已刷新');
      } catch (err) {
        if (showToast) ui.toast('err', err.message || '读取状态失败');
        else lamp.className = 'light light--error';
      }
    }

    async function refreshLogs(showToast) {
      try {
        const r = await api('GET', '/api/ysp/logs?lines=120');
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

    // ======================= 动作 =======================
    async function doAction(action) {
      if (st.busy) return;
      // 停止 / 重启会掐断正在看的流，先确认
      if (action !== 'start') {
        const ok = await ui.confirmDialog({
          title: action === 'stop' ? '停止直播服务？' : '重启直播服务？',
          body: el('div', {}, [
            el('p', { text: action === 'stop' ? '正在播放的播放器会立刻断流。' : '服务会中断约 2–6 秒，播放器需要重新拉流。' }),
            el('p', { class: 'muted', text: '直播服务独立于 MacKit 运行，这一步只影响 ysp-live 本身。' }),
          ]),
          confirmLabel: action === 'stop' ? '停止' : '重启',
        });
        if (!ok) return;
      }
      st.busy = true;
      if (st.data) paint(st.data);
      try {
        await ctx.runTask('ysp', action);
      } catch { /* runTask 内部已 toast */ }
      finally {
        st.busy = false;
        // 成功路径由下面的 'done' 订阅强制刷新一次，这里不再重复请求；
        // 失败路径（任务没提交成功）状态没变，只需把按钮解禁。
        if (st.data) paint(st.data);
      }
    }

    // ======================= 装配 =======================
    body.append(statusCard, subCard, logCard);

    // 任务结束后刷新（起停的动作结果会改变状态与日志）
    ctx.on('done', (t) => {
      if (t && t.module === 'ysp') { refresh(false, true); refreshLogs(false); }
    });

    refresh(false);
    refreshLogs(false);
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
