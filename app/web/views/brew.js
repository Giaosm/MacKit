/**
 * MacKit · Homebrew 管家（视图）
 *
 * 结构（按用户澄清后的目标形态）：
 *   - 环境卡 + 通道指示（实际通道由 SSE 的 step.channel 反映）
 *   - 首屏 = 「升级列表」（逐项形态）：
 *       · 顶部「⬆ 一键更新本体并刷新索引（代理优先）」+「⟳ 重查可更新项」（后者只重算，不下载）
 *       · 所有可更新项（formula / cask 分组）逐项显示「当前版本 → 可用版本」
 *       · 每项两个互斥按钮「代理 / 直连」，默认都不选；未选 = 不更新
 *       · 快捷「全部代理 / 全部直连 / 清除全部选择」+ 实时汇总「已选 N 项（代理 X / 直连 Y）」
 *       · 底部「▶ 开始逐项升级」→ upgrade_one_by_one（items: [{name,kind,mode}]，mode∈proxy|direct|skip）
 *   - 卸载管理：Formula / Cask（多选 + 二次确认 + brew info 前 5 行）/ Tap（核心源加强警告 + 空态解释）
 *   - 软件下载：Formula / Cask 双类别，本地全量索引搜索（brew info --json=v2 补详情），结果逐项「代理/直连」直接安装
 *   - 设置（端口 / 镜像 5 卡 / 自动降级 / 缓存清理；改端口后仅提示，不自动改 Git）
 *     注：通道不再手选 —— 由后端按目标主机自动决定（走 GitHub 代理优先，其余直连优先）。
 *
 * 已移除：原「更新中心」标签与 6 步完整更新前端入口、「更新策略」单选、已装统计入口。
 *         原「历史」标签（升级/卸载历史表）—— 任务历史统一由侧边栏「任务历史」承载，避免两处重复。
 */

const MIRRORS = [
  { id: 'official', label: '官方 (GitHub)' }, { id: 'tuna', label: '清华 TUNA' },
  { id: 'ustc', label: '中科大 USTC' }, { id: 'aliyun', label: '阿里云' }, { id: 'tencent', label: '腾讯云' },
];
const CORE_TAPS = ['homebrew/core', 'homebrew/cask'];
const CHANNEL_LABEL = { direct: '直连', proxy: '代理', direct_first: '直连优先', proxy_first: '代理优先', auto: '自动' };

export default {
  id: 'brew',
  title: 'Homebrew 管家',

  mount(root, ctx) {
    const { el, ui, api } = ctx;
    const envBox = el('div', { class: 'section' });
    const tabsBox = el('div', { class: 'toolbar' });
    const panelBox = el('div');

    // 体检反馈：右上角「上次体检 时间」+ 按钮忙碌态。
    // 修复「点了没反应」：刷新前后卡片数值往往完全一致，若不给任何可见反馈，用户会以为按钮失效。
    const envMeta = el('span', { class: 'view-head__meta' });
    // 「元数据同步于 X」：brew 元数据是「可更新」判定的真相来源，它只由 `brew update` 刷新
    // （启动后服务端会自动同步一次，实测 1.7~3.2s）。把它显性化，用户才能判断这个数字有多新。
    const metaSync = el('span', { class: 'view-head__meta' });
    const envBtn = el('button', { class: 'btn btn--ghost', type: 'button', text: '⟳ 重新体检', on: { click: () => loadEnv(true) } });

    root.append(el('div', { class: 'view-head' }, [
      el('div', {}, [el('h1', { text: 'Homebrew 管家' }), el('div', { class: 'muted', text: '升级 · 卸载 · 设置' })]),
      el('div', { class: 'row' }, [
        // 模块级通道：只管**索引下载 / brew update / 元数据同步**。
        // 逐项升级与安装仍按用户在每一项上点的「代理 / 直连」按钮执行（用户明确要求）。
        ui.netChannel('brew', '通道', '影响索引下载与 brew update；逐项升级 / 安装仍按你点的「代理 / 直连」按钮执行'),
        metaSync, envMeta, envBtn,
      ]),
    ]), envBox, tabsBox, panelBox);

    const TABS = [['upgrade', '升级列表'], ['download', '软件下载'], ['uninstall', '卸载管理'], ['settings', '设置']];
    let active = 'upgrade';
    let env = null;
    let envBusy = false;
    let config = null;
    // 本实例的延时器（Cask 搜索防抖）与**面板级**订阅（解绑器）登记表。
    // 必须是 mount 局部变量：unmount() 是 mount() 的兄弟方法、看不到这里，而路由 teardown
    // 已按实例回收订阅；若放模块作用域，旧实例晚执行的清理会误杀新实例的订阅与延时器。
    // （面板级订阅也经 ctx.on 压进了视图级 subs，这里额外登记只为「切换面板时主动解绑」。）
    const pendingTimers = new Set();
    const panelSubs = [];

    // ---------------- 环境卡 ----------------
    function renderEnv() {
      envBox.innerHTML = '';
      if (!env) { envBox.append(el('div', { class: 'view-loading', text: '正在体检…' })); return; }
      const b = env.brew || {}, n = env.network || {}, m = env.mirror || {}, pp = env.proxyPorts || {};
      const running = ctx.state.task && ctx.state.task.status === 'running' ? ctx.state.task : null;
      const chStep = running && running.steps ? running.steps.filter((s) => s.channel).pop() : null;
      const chBadge = chStep ? ui.badge('当前通道 ' + CHANNEL_LABEL[chStep.channel], chStep.channel) : ui.badge('空闲', 'muted');
      const grid = el('div', { class: 'grid grid--3' }, [
        ui.card('🍺 环境', el('div', { class: 'card__rows' }, [
          ui.kv('版本', b.version || '未检测到'),
          ui.kv('已装', `formula ${b.formulaCount || 0} / cask ${b.caskCount || 0}`),
          ui.kv('可更新', `${(b.outdatedFormula || 0) + (b.outdatedCask || 0)} 项`),
        ]), { light: b.status || 'warn', extra: chBadge }),
        ui.card('🌐 网络', el('div', { class: 'card__rows' }, [
          ui.kv('直连', n.direct && n.direct.ok ? `🟢 ${n.direct.ip || '正常'}` : '🔴 不可达'),
          ui.kv('代理', n.proxy && n.proxy.ok ? `🟢 ${n.proxy.ip || '正常'}` : '🔴 不可达'),
        ]), { light: n.status || 'warn' }),
        ui.card('⚙ 配置', el('div', { class: 'card__rows' }, [
          ui.kv('镜像源', m.label || m.id || '—'),
          ui.kv('代理端口', `${pp.http || '—'} / ${pp.socks5 || '—'}`),
          ui.kv('config', el('span', { class: 'mono', text: pp.configPath || '—' })),
        ]), { light: m.status || 'warn' }),
      ]);
      envBox.append(grid);
      // 未安装 / 环境未配置：给出醒目入口（2026-09-16 新增）
      if (!b.installed) envBox.append(homebrewMissingCard(b));
      else if (!b.shellenvConfigured) envBox.append(shellenvMissingCard(b));
    }

    /** 未检测到 Homebrew：一键安装（官方脚本，代理优先）。 */
    function homebrewMissingCard(b) {
      const btn = el('button', { class: 'btn btn--primary', type: 'button', text: '⬇ 一键安装 Homebrew（代理优先）' });
      btn.addEventListener('click', async () => {
        const body = el('div', {}, [
          el('p', { text: '将执行 Homebrew 官方安装流程（brew.sh 的 install.sh）：' }),
          el('ol', {}, [
            el('li', { text: '下载官方安装脚本（代理优先，失败自动换直连）' }),
            el('li', { text: '运行官方脚本安装 Homebrew（系统会弹出密码框，请输入你的登录密码）' }),
            el('li', { text: `自动把 brew 环境变量写入 ${b.shellenvRcDisplay || '~/.zprofile'}，装完新开终端即可用 brew` }),
          ]),
          el('div', { class: 'warn-box', text: '⚠ 安装过程需要管理员权限，会弹出 1 次系统密码框；密码只交给 sudo，MacKit 不读取、不保存。安装耗时取决于网络（通常几分钟）。' }),
        ]);
        if (await ui.confirmDialog({ title: '确认安装 Homebrew？', body, confirmLabel: '开始安装' })) {
          try { await ctx.runTask('brew', 'install_homebrew', {}, { confirm: true }); } catch { /* runTask 内部已 toast */ }
          loadEnv(true);
        }
      });
      return ui.card('🍺 未检测到 Homebrew', el('div', { class: 'card__rows' }, [
        el('div', { class: 'muted', text: '本机未安装 Homebrew。点击下方按钮可用官方脚本一键安装（默认走代理），安装完成后会自动配置好终端环境变量。' }),
        el('div', { class: 'row section' }, [btn]),
      ]), { light: 'error' });
    }

    /** 已安装但终端未配置环境变量：一键写入 shellenv。 */
    function shellenvMissingCard(b) {
      // 如实反映将要写入的内容：rc 目标、shell 类别、brew 路径全部由后端下发
      // （本卡片仅在已安装时出现，故 b.path 必定存在；不在此硬编码家目录/安装前缀）
      const rc = b.shellenvRcDisplay || b.shellenvRc || 'rc 文件';
      const line = b.shellenvLine || `eval "$(${b.path} shellenv ${b.shellKind || 'zsh'})"`;
      const btn = el('button', { class: 'btn btn--primary', type: 'button', text: '⚙ 一键配置环境变量' });
      btn.addEventListener('click', async () => {
        const body = el('div', {}, [
          el('p', { text: '检测到 Homebrew 已安装，但终端配置文件中没有 brew 环境变量。将执行：' }),
          el('div', { class: 'diff' }, [
            el('div', { class: 'diff__line', text: `# 追加到 ${rc}（幂等，已存在则跳过）` }),
            el('div', { class: 'diff__line', text: line }),
          ]),
          el('p', { class: 'muted', text: `写完新开终端即可生效；想让当前终端立刻生效，可执行：source ${rc}` }),
        ]);
        if (await ui.confirmDialog({ title: '确认配置 Homebrew 环境变量？', body, confirmLabel: '写入配置' })) {
          try { await ctx.runTask('brew', 'setup_shellenv', {}, { confirm: true }); } catch { /* runTask 内部已 toast */ }
          loadEnv(true);
        }
      });
      return ui.card('⚙ Homebrew 终端环境未配置', el('div', { class: 'card__rows' }, [
        el('div', { class: 'muted', text: 'Homebrew 已安装，但终端里可能还用不了 brew 命令（新开终端提示 command not found）。点下方按钮自动写入配置，之后新开终端即可直接使用。' }),
        el('div', { class: 'row section' }, [btn]),
      ]), { light: 'warn' });
    }

    /** 元数据同步状态一行文案（同步中 / 同步于 X / 同步失败）。 */
    function renderMetaSync() {
      const bm = ctx.state.brewMeta;
      if (!bm) { metaSync.textContent = ''; return; }
      if (bm.refreshing) { metaSync.textContent = '⟳ 正在同步元数据…'; return; }
      const at = bm.refreshedAt ? `元数据同步于 ${ctx.fmtTime(bm.refreshedAt)}` : '元数据未同步过';
      if (bm.lastError && !bm.refreshing) metaSync.textContent = `${at} · ⚠ 上次同步失败`;
      else metaSync.textContent = bm.stale ? `${at}（已过期）` : at;
    }

    async function loadEnv(force) {
      if (envBusy) return;
      envBusy = true;
      const idleText = envBtn.textContent;
      // 忙碌态：按钮禁用 + 文案变化 + 左上角提示 + 卡片淡化 —— 让「点了有反应」肉眼可见
      envBtn.disabled = true; envBtn.textContent = '⏳ 体检中…';
      envMeta.textContent = '正在体检…';
      envBox.classList.add('is-busy');
      try {
        env = await ctx.refreshEnv(force);
        renderEnv();
        const b = env.brew || {};
        envMeta.textContent = `上次体检 ${ctx.fmtTime(Date.now())}`;
        if (force) ui.toast('ok', `体检完成 · 可更新 ${(b.outdatedFormula || 0) + (b.outdatedCask || 0)} 项`);
      } catch (err) {
        // ctx.refreshEnv 内部已 toast 报错，这里只补卡片区的错误块，避免重复弹窗
        envBox.innerHTML = '';
        envBox.append(el('div', { class: 'err-box', text: `体检失败：${err.message || err}` }));
        envMeta.textContent = '';
      } finally {
        envBusy = false; envBtn.disabled = false; envBtn.textContent = idleText;
        envBox.classList.remove('is-busy');
      }
    }

    // ---------------- Tab ----------------
    function renderTabs() {
      tabsBox.innerHTML = '';
      for (const [id, label] of TABS) tabsBox.append(el('button', { class: `btn btn--sm${active === id ? ' btn--primary' : ''}`, type: 'button', text: label, on: { click: () => { active = id; renderTabs(); renderPanel(); } } }));
    }

    async function cancelCurrent(btn) {
      const t = ctx.state.task;
      if (!t) return;
      btn.disabled = true; btn.textContent = '取消中…';
      try { await api('POST', `/api/tasks/${encodeURIComponent(t.id)}/cancel`); ui.toast('warn', '已请求取消（SIGTERM→3s→SIGKILL）'); }
      catch (err) { ui.toast('err', err.message || '取消失败'); btn.disabled = false; btn.textContent = '取消任务'; }
    }

    // ================= 面板：升级列表（逐项选择通道） =================
    function panelUpgrade(box) {
      const host = el('div', { class: 'section' });
      let data = { formulae: [], casks: [], counts: { formula: 0, cask: 0 }, checkedAt: 0 };
      const decisions = new Map(); // `${kind}:${name}` → 'proxy'|'direct'（未设置 = 不更新）
      let filter = '';

      // ---- 任务进度 / 取消：整个面板生命周期只注册一次 'task' 监听（避免累积）----
      const counts = el('span', { class: 'muted' });
      const cancelBtn = el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: '取消任务', disabled: true, on: { click: () => cancelCurrent(cancelBtn) } });
      const refreshTaskState = () => {
        const t = ctx.state.task;
        counts.textContent = t && t.counts ? `${t.title || '任务'}：✅ 成功 ${t.counts.ok} · ⏭ 跳过 ${t.counts.skip} · ❌ 失败 ${t.counts.fail}` : '';
        cancelBtn.disabled = !ctx.state.running;
      };
      onPanel('task', refreshTaskState);

      // ---- 常驻节点 ----
      const topBar = el('div', { class: 'toolbar' });
      const searchI = el('input', { type: 'search', placeholder: '搜索名称…', style: 'max-width:200px', on: { input: (e) => { filter = e.target.value.trim().toLowerCase(); drawList(); } } });
      const summary = el('div', { class: 'muted section' });
      const listHost = el('div');

      const allItems = () => [
        ...data.formulae.map((x) => ({ ...x, kind: 'formula' })),
        ...data.casks.map((x) => ({ ...x, kind: 'cask' })),
      ];
      const keyOf = (it) => `${it.kind}:${it.name}`;

      async function load() {
        host.innerHTML = ''; host.append(el('div', { class: 'view-loading', text: '正在检查可更新项…' }));
        try { data = await api('GET', '/api/brew/outdated'); } catch (err) { host.innerHTML = ''; host.append(el('div', { class: 'err-box', text: `检查失败：${err.message || err}` })); return; }
        // 形状兜底：后端契约是 { formulae, casks, counts, checkedAt }，缺字段时按空处理，
        // 避免后端演进 / 代理层返回异形 JSON 时把整个面板炸成白屏（2026-09-19）。
        data = {
          formulae: [], casks: [], counts: { formula: 0, cask: 0 }, checkedAt: null,
          ...(data || {}),
          counts: { formula: 0, cask: 0, ...((data && data.counts) || {}) },
        };
        decisions.clear();
        draw();
      }

      /**
       * 「重查可更新项」：若元数据已过期，**先同步一次**（`brew update`，≈2s）再重算 ——
       * 用户对「重查」的直觉就是「拿到新的」；元数据没过期时它就是纯重算（<1s，不联网）。
       * ★ 必须定义在 panelUpgrade 内：它要用本面板的 load()（mock 在 mount 作用域会 ReferenceError）。
       */
      async function recheck(btn) {
        const bm = ctx.state.brewMeta || {};
        let refreshed = false;
        if (bm.stale && bm.enabled !== false && !bm.refreshing) {
          const idle = btn.textContent;
          btn.disabled = true; btn.textContent = '同步元数据…';
          try { await api('POST', '/api/brew/meta/refresh'); refreshed = true; }
          catch (err) { ui.toast('warn', `元数据同步失败（仍按现有数据重算）：${err.message || err}`); }
          finally { btn.disabled = false; btn.textContent = idle; }
        }
        load();
        // 同步过就顺带刷一次体检，避免顶部「可更新 N 项」与下面的列表数字打架
        if (refreshed) loadEnv(false);
      }

      function setMode(key, m) {
        // 互斥；再次点击已选模式 → 取消选择（未选 = 不更新）
        if (decisions.get(key) === m) decisions.delete(key); else decisions.set(key, m);
        drawList();
      }
      function applyAll(m) { for (const it of allItems()) decisions.set(keyOf(it), m); drawList(); }
      function clearAll() { decisions.clear(); drawList(); }
      function selection() {
        let proxy = 0, direct = 0;
        for (const it of allItems()) { const m = decisions.get(keyOf(it)); if (m === 'proxy') proxy += 1; else if (m === 'direct') direct += 1; }
        return { proxy, direct, total: proxy + direct };
      }
      function renderSummary() {
        const s = selection();
        const total = data.counts.formula + data.counts.cask;
        summary.textContent = `已选 ${s.total} 项（代理 ${s.proxy} / 直连 ${s.direct}）；未选中的项不会更新。共 ${total} 项可更新。`;
      }
      function mutualBtn(key, cur, m, label) {
        return el('button', { class: `btn btn--sm${cur === m ? ' btn--primary' : ''}`, type: 'button', text: label, on: { click: () => setMode(key, m) } });
      }
      function itemRow(it) {
        const key = keyOf(it);
        const cur = decisions.get(key) || null;
        return el('div', { class: 'row row--between', style: 'padding:6px 0; border-bottom:1px solid var(--border,#2a2a2a)' }, [
          el('span', {}, [
            el('span', { class: 'mono', text: it.name }), ' ', ui.badge(it.kind, 'muted'), ' ',
            el('span', { class: 'muted', text: `当前 ${it.current || '—'} → 可用 ${it.latest || '—'}` }),
          ]),
          el('span', {}, [mutualBtn(key, cur, 'proxy', '代理'), ' ', mutualBtn(key, cur, 'direct', '直连')]),
        ]);
      }
      function groupCard(title, items, kind) {
        const shown = items.filter((it) => !filter || it.name.toLowerCase().includes(filter));
        const rows = shown.length
          ? shown.map((x) => itemRow({ ...x, kind }))
          : [el('div', { class: 'muted', text: filter ? '（无匹配项）' : '（无）' })];
        return ui.card(title, el('div', {}, rows));
      }
      // 自带更新（auto_updates）的 cask：brew 默认不管，MacKit 也不交给 brew 升级
      // —— brew 只比版本字符串是否相等，会把应用自更新到的更高版本「升」回旧版（版本回退）。
      // 但仍然列出来：否则列表为空时用户只看到「无需更新」，不知道这些应用为什么不见了
      // （2026-09-22 用户反馈「没检测到啊」）。
      function autoCaskCard() {
        const items = Array.isArray(data.autoCasks) ? data.autoCasks : [];
        if (items.length === 0) return null;
        const rows = items.map((it) => el('div', { class: 'row row--between', style: 'padding:6px 0' }, [
          el('span', {}, [
            el('span', { class: 'mono', text: it.name }), ' ', ui.badge('自带更新', 'muted'), ' ',
            el('span', { class: 'muted', text: `brew 记账 ${it.current || '—'} → cask ${it.latest || '—'}` }),
          ]),
          el('span', { class: 'muted', text: '由应用自身升级' }),
        ]));
        return ui.card(`自带更新的应用（${items.length}，不参与 brew 升级）`, el('div', {}, rows));
      }
      function drawList() {
        listHost.innerHTML = '';
        const total = data.counts.formula + data.counts.cask;
        if (total === 0) {
          listHost.append(ui.card('可更新项', ui.empty({
            icon: '🎉', title: '所有 Homebrew 软件包均为最新，无需更新',
            text: `Formula ${data.counts.formula} 项 · Cask ${data.counts.cask} 项　　上次检查：${data.checkedAt ? ctx.fmtDateTime(data.checkedAt) : '—'}`,
            // 这里原先还有一个「重新检查」按钮：与正上方工具条的按钮同名同功能，
            // 两处并存只会让用户分不清各自做什么（2026-09-21 去掉重复入口，说明文字里已给出时间）。
          })));
          const emptyAc = autoCaskCard();
          if (emptyAc) listHost.append(emptyAc);
          renderSummary();
          return;
        }
        listHost.append(el('div', { class: 'row', style: 'margin-bottom:8px; flex-wrap:wrap' }, [
          el('span', { class: 'muted', text: '快捷：' }),
          el('button', { class: 'btn btn--sm', type: 'button', text: '全部代理', on: { click: () => applyAll('proxy') } }),
          el('button', { class: 'btn btn--sm', type: 'button', text: '全部直连', on: { click: () => applyAll('direct') } }),
          el('button', { class: 'btn btn--sm', type: 'button', text: '清除全部选择', on: { click: clearAll } }),
          el('button', { class: 'btn btn--sm btn--primary', type: 'button', text: '▶ 开始逐项升级', on: { click: perItemRun } }),
          cancelBtn,
          counts,
        ]));
        listHost.append(el('div', { class: 'grid grid--2' }, [
          groupCard(`Formula（${data.formulae.length}）`, data.formulae, 'formula'),
          groupCard(`Cask（${data.casks.length}）`, data.casks, 'cask'),
        ]));
        // 说清为什么某些应用不在升级列表里（auto_updates 由应用自身升级，交给 brew 只会版本回退）
        const ac = autoCaskCard();
        if (ac) listHost.append(ac);
        renderSummary();
      }
      function draw() {
        host.innerHTML = '';
        topBar.innerHTML = '';
        topBar.append(
          el('button', { class: 'btn btn--primary', type: 'button', text: '⬆ 一键更新本体并刷新索引（代理优先）', on: { click: () => { ctx.runTask('brew', 'brew_update').catch(() => {}); } } }),
          el('button', { class: 'btn', type: 'button', text: '⟳ 重查可更新项', on: { click: (e) => recheck(e.target) } }),
          el('span', { class: 'grow' }),
          searchI,
        );
        host.append(topBar, summary, listHost);
        drawList();
        refreshTaskState();
      }
      function perItemRun() {
        const items = allItems().map((it) => ({ name: it.name, kind: it.kind, mode: decisions.get(keyOf(it)) || 'skip' }));
        if (!items.length) return ui.toast('warn', '无任何可更新项');
        if (!items.some((it) => it.mode !== 'skip')) return ui.toast('warn', '请先选择要升级的项目');
        ctx.runTask('brew', 'upgrade_one_by_one', { items }).catch(() => {});
      }

      box.append(host);
      onPanel('done', (t) => { if (t.module === 'brew') { load(); loadEnv(false); } });
      load();
    }

    // ================= 面板：卸载管理 =================
    // Formula 与 Cask 都走「已装列表多选 → 二次确认 → 批量卸载」，差异只有接口 kind 与动作名。
    const UNINSTALL_TABS = [['cask', 'Cask 应用'], ['formula', 'Formula'], ['tap', 'Tap 软件源']];
    const PKG_LABEL = { cask: 'Cask 应用', formula: 'Formula' };

    function panelUninstall(box) {
      let kind = 'cask';
      const tabs = el('div', { class: 'toolbar' });
      const host = el('div');
      let installed = { formulae: [], casks: [], taps: [] };
      let ct = null;
      const drawTabs = () => { tabs.innerHTML = ''; for (const [k, l] of UNINSTALL_TABS) tabs.append(el('button', { class: `btn btn--sm${kind === k ? ' btn--primary' : ''}`, type: 'button', text: l, on: { click: () => { kind = k; drawTabs(); draw(); } } })); };
      async function load() {
        host.innerHTML = ''; host.append(el('div', { class: 'view-loading', text: '正在读取已安装列表…' }));
        try { installed = await api('GET', '/api/brew/installed'); } catch (err) { host.innerHTML = ''; host.append(el('div', { class: 'err-box', text: `读取失败：${err.message || err}` })); return; }
        draw();
      }
      /** Formula / Cask 卸载共用：勾选 → 拉取 brew info 前 5 行 → 二次确认 → 派发对应动作。 */
      async function uninstallPackages() {
        const rows = ct.getSelectedRows();
        if (!rows.length) return ui.toast('warn', `请先勾选要卸载的 ${PKG_LABEL[kind]}`);
        const infos = [];
        for (const r of rows) { try { infos.push({ name: r.name, lines: (await api('GET', `/api/brew/info?kind=${kind}&name=${encodeURIComponent(r.name)}`)).lines }); } catch { infos.push({ name: r.name, lines: [] }); } }
        const body = el('div', {}, [
          el('p', { text: '将卸载：' }), el('ul', {}, rows.map((r) => el('li', { text: r.name }))),
          ...infos.map((b) => el('div', {}, [el('div', { class: 'muted', text: `${b.name} 信息（brew info 前 5 行）：` }), el('div', { class: 'diff' }, (b.lines.length ? b.lines : ['（无信息）']).map((l) => el('div', { class: 'diff__line', text: l })))])),
          el('div', { class: 'err-box', text: kind === 'formula'
            ? '⚠ 卸载将删除该 Formula 及其安装文件（依赖它的软件包可能受影响），且不可撤销。'
            : '⚠ 卸载将删除应用及其数据，且不可撤销。' }),
        ]);
        const action = kind === 'formula' ? 'uninstall_formulae' : 'uninstall_casks';
        if (await ui.confirmDialog({ title: `确认卸载 ${PKG_LABEL[kind]}（${rows.length} 个）`, body, confirmLabel: '确认卸载' })) {
          try { await ctx.runTask('brew', action, { names: rows.map((r) => r.name) }, { confirm: true }); } catch { /* runTask 内部已 toast */ }
        }
      }
      async function uninstallTaps() {
        const checked = Array.from(host.querySelectorAll('input[type=checkbox][data-tap]:checked')).map((c) => c.dataset.tap);
        if (!checked.length) return ui.toast('warn', '请先勾选要卸载的 Tap 软件源');
        const core = checked.filter((t) => CORE_TAPS.includes(t));
        const body = el('div', {}, [el('p', { text: '将卸载：' }), el('ul', {}, checked.map((t) => el('li', { text: t }))), core.length ? el('div', { class: 'err-box', text: `⚠ ${core.join('、')} 为 Homebrew 核心软件源，卸载后需通过 brew tap 重新安装。` }) : null]);
        if (await ui.confirmDialog({ title: `确认卸载 Tap 软件源（${checked.length} 个）`, body, confirmLabel: '确认卸载' })) {
          try { await ctx.runTask('brew', 'uninstall_taps', { names: checked }, { confirm: true }); } catch { /* runTask 内部已 toast */ }
        }
      }
      function draw() {
        host.innerHTML = '';
        if (kind === 'tap') {
          const taps = installed.taps || [];
          if (!taps.length) { host.append(ui.card('Tap 软件源', ui.empty({ icon: 'ℹ', title: '未检测到自定义 Tap 软件源', text: 'Homebrew 7 默认不再显式列出 core / cask 等内置源，属正常现象。', actions: [{ label: '重新检测', onClick: load }] }))); return; }
          const list = el('ul', { class: 'filelist' }, taps.map((t) => el('li', {}, [el('label', { class: 'check' }, [el('input', { type: 'checkbox', dataset: { tap: t } }), el('span', { text: t, class: CORE_TAPS.includes(t) ? 'dot-warn' : '' })])])));
          host.append(ui.card('Tap 软件源', el('div', {}, [list, el('div', { class: 'row section' }, [el('button', { class: 'btn btn--danger', type: 'button', text: '卸载选中', on: { click: uninstallTaps } })])])));
          return;
        }
        const label = PKG_LABEL[kind];
        const names = (kind === 'formula' ? installed.formulae : installed.casks) || [];
        if (!names.length) { host.append(ui.card(label, ui.empty({ icon: 'ℹ', title: `没有已安装的 ${label}`, actions: [{ label: '重新检测', onClick: load }] }))); return; }
        ct = ui.dataTable({ columns: [{ key: 'name', label: '名称' }], rows: names.map((n) => ({ name: n })), selectable: true, searchable: true, rowKey: (r) => r.name, emptyText: '无' });
        host.append(ui.card(label, el('div', {}, [ct.el, el('div', { class: 'row section' }, [el('button', { class: 'btn btn--danger', type: 'button', text: '卸载选中', on: { click: uninstallPackages } })])])));
      }
      onPanel('done', (t) => { if (t.module === 'brew') { load(); loadEnv(false); } });
      box.append(tabs, host); drawTabs(); load();
    }

    // ================= 面板：软件下载（Formula / Cask 搜索 + 直连/代理安装） =================
    // 两个类别共用同一套流程（搜索 / 排序 / 安装通道选择），差异只有：接口 kind、安装动作名、文案。
    const DOWNLOAD_KINDS = [
      ['cask', 'Cask 应用（图形界面）'],
      ['formula', 'Formula（命令行工具 / 库）'],
    ];
    const DOWNLOAD_PLACEHOLDER = {
      cask: '搜索 Cask 应用，如：chrome、wechat、vscode…',
      formula: '搜索 Formula，如：node、ffmpeg、ripgrep…',
    };
    const DOWNLOAD_LABEL = { cask: 'Cask 应用', formula: 'Formula' };

    function panelDownload(box) {
      const host = el('div', { class: 'section' });
      const kindTabs = el('div', { class: 'toolbar' });
      let kind = 'cask';
      const searchI = el('input', { type: 'search', placeholder: DOWNLOAD_PLACEHOLDER[kind], style: 'max-width:340px' });
      const status = el('span', { class: 'muted' });
      const cancelBtn = el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: '取消任务', disabled: true, on: { click: (e) => cancelCurrent(e.target) } });
      const listHost = el('div');
      let q = '';
      let seq = 0;   // 竞态保护：只渲染最后一次搜索的结果
      let timer = null;

      const refreshTaskState = () => { cancelBtn.disabled = !ctx.state.running; };
      onPanel('task', refreshTaskState);

      function drawKindTabs() {
        kindTabs.innerHTML = '';
        for (const [k, label] of DOWNLOAD_KINDS) {
          kindTabs.append(el('button', {
            class: `btn btn--sm${kind === k ? ' btn--primary' : ''}`, type: 'button', text: label,
            on: { click: () => { if (kind === k) return; kind = k; drawKindTabs(); switchKind(); } },
          }));
        }
      }
      /** 切换类别：作废在途请求（seq 自增），改写输入提示，有词则立刻重搜。 */
      function switchKind() {
        seq += 1;
        searchI.placeholder = DOWNLOAD_PLACEHOLDER[kind];
        status.textContent = '';
        if (q) runSearch(); else showHint();
      }

      function showHint() {
        const isCask = kind === 'cask';
        listHost.innerHTML = '';
        listHost.append(ui.empty({
          icon: '📦', title: isCask ? '搜索并安装 Cask 应用' : '搜索并安装 Formula（命令行工具 / 库）',
          text: isCask
            ? '支持按名称搜索（含中文名，如「微信」「企业微信」），效果等同 formulae.brew.sh/cask；点「代理下载 / 直连下载」直接创建安装任务。首次搜索需下载一次索引，之后本地秒搜。'
            : '支持按名称 / 描述搜索 Homebrew formula，效果等同 formulae.brew.sh；点「代理安装 / 直连安装」直接创建安装任务（等价 brew install <名称>）。首次搜索需下载一次索引，之后本地秒搜。',
        }));
      }

      async function runSearch() {
        const my = ++seq;
        const k = kind;  // 绑定本次请求的类别：响应回来时用户可能已切走
        const label = DOWNLOAD_LABEL[k];
        status.textContent = '搜索中…';
        listHost.innerHTML = '';
        listHost.append(el('div', { class: 'view-loading', text: `正在搜索 ${label}…` }));
        try {
          const data = await api('GET', `/api/brew/package-search?kind=${k}&q=${encodeURIComponent(q)}`);
          if (my !== seq) return;
          status.textContent = (data.total > 0
            ? `共 ${data.total} 个匹配${data.total > data.limit ? `，显示前 ${data.limit} 个` : ''}`
            : '') + (data.indexedAt ? ` · 索引 ${ctx.fmtDateTime(data.indexedAt)}` : '');
          listHost.innerHTML = '';
          if (!data.results || data.results.length === 0) {
            listHost.append(ui.empty({ icon: '🔍', title: `没有匹配「${q}」的 ${label}`, text: '试试更短的关键词，或确认它在 Homebrew 仓库中存在。' }));
            return;
          }
          listHost.append(ui.card(`${label} 搜索结果`, el('div', {}, data.results.map((r) => resultRow(r, k)))));
        } catch (err) {
          if (my !== seq) return;
          status.textContent = '';
          listHost.innerHTML = '';
          listHost.append(el('div', { class: 'err-box', text: `搜索失败：${err.message || err}` }));
        }
      }

      function install(name, mode, k) {
        // runTask 内部有「任务运行中」互斥 + 自动打开日志抽屉，失败会 toast
        const action = k === 'formula' ? 'install_formulae' : 'install_casks';
        ctx.runTask('brew', action, { items: [{ name, mode }] }).catch(() => {});
      }

      function resultRow(r, k) {
        const verb = k === 'formula' ? '安装' : '下载';
        const installedBadge = r.installed
          ? ui.badge(`已装${r.installed === r.version ? '' : ' ' + r.installed}`, 'ok')
          : null;
        return el('div', { class: 'row row--between', style: 'padding:6px 0; border-bottom:1px solid var(--border,#2a2a2a)' }, [
          el('span', { style: 'min-width:0' }, [
            el('span', { class: 'mono', text: r.token }), ' ', installedBadge, ' ',
            r.name && r.name !== r.token ? el('span', { text: r.name + ' ' }) : null,
            el('span', { class: 'muted', text: r.desc || '' }),
            r.version ? el('span', { class: 'muted', text: `  ·  ${r.version}` }) : null,
          ]),
          el('span', { style: 'flex-shrink:0; margin-left:12px' }, [
            el('button', { class: 'btn btn--sm', type: 'button', text: `代理${verb}`, on: { click: () => install(r.token, 'proxy', k) } }), ' ',
            el('button', { class: 'btn btn--sm', type: 'button', text: `直连${verb}`, on: { click: () => install(r.token, 'direct', k) } }),
          ]),
        ]);
      }

      searchI.addEventListener('input', (e) => {
        q = e.target.value.trim();
        if (timer) { clearTimeout(timer); pendingTimers.delete(timer); timer = null; }
        if (!q) { seq += 1; status.textContent = ''; showHint(); return; }
        // 防抖：停止输入 400ms 后再搜（延时器登记到 pendingTimers，便于 unmount 清理）
        timer = setTimeout(() => { pendingTimers.delete(timer); timer = null; if (!root.isConnected) return; runSearch(); }, 400);
        pendingTimers.add(timer);
      });

      // 安装任务结束后刷新「已装」标识（顺带覆盖其他 brew 动作对已装列表的影响）
      onPanel('done', (t) => {
        if (t.module !== 'brew') return;
        if (q) runSearch();
        // 安装 / 卸载会改变「已装」与「可更新」计数 → 顶部环境卡一起刷新，避免与列表数字打架
        loadEnv(false);
      });

      host.append(kindTabs, el('div', { class: 'toolbar' }, [searchI, el('span', { class: 'grow' }), status, cancelBtn]), listHost);
      drawKindTabs();
      showHint();
      box.append(host);
    }

    // ================= 面板：设置 =================
    function panelSettings(box) {
      const host = el('div', { class: 'section' });
      const hintBox = el('div');
      function draw() {
        host.innerHTML = '';
        if (!config) { host.append(el('div', { class: 'view-loading', text: '读取配置…' })); return; }
        const bg = config.brewgo || {}, mk = config.mackit || {};

        // 代理端口
        const httpI = el('input', { type: 'number', value: String(bg.httpPort || ''), style: 'max-width:140px' });
        const socksI = el('input', { type: 'number', value: String(bg.socksPort || ''), style: 'max-width:140px' });
        const portCard = ui.card('🔌 代理端口', el('div', {}, [
          el('div', { class: 'row' }, [el('span', { class: 'muted', style: 'width:120px', text: 'HTTP 端口' }), httpI]),
          el('div', { class: 'row section' }, [el('span', { class: 'muted', style: 'width:120px', text: 'SOCKS5 端口' }), socksI]),
          el('div', { class: 'muted', text: '非纯数字或超范围（1–65535）的输入将被忽略并保持原值。' }),
          el('div', { class: 'row section' }, [el('button', { class: 'btn btn--primary', type: 'button', text: '保存端口', on: { click: () => savePorts(httpI, socksI) } })]),
        ]));

        // 镜像源
        const mirrorCard = ui.card('🪞 镜像源', el('div', { class: 'grid grid--3' }, MIRRORS.map((m) => el('button', {
          class: `btn${bg.mirror === m.id ? ' btn--primary' : ''}`, type: 'button', text: m.label,
          on: { click: () => saveConfig({ mirror: m.id }, `镜像源已切换为「${m.label}」`) },
        }))));

        // 通道由目标主机自动决定（无需手动选）+ 自动降级开关
        const chk = el('input', { type: 'checkbox', checked: mk.autoFallback !== false, on: { change: (e) => saveConfig({ autoFallback: e.target.checked }, e.target.checked ? '已开启自动降级' : '已关闭自动降级（失败即终止）') } });
        const chCard = ui.card('🎚 网络通道', el('div', { class: 'card__rows' }, [
          // 2026-09-22：原先这里是「默认通道」下拉（自动/直连优先/代理优先）—— 那个设置从未被读取，
          // 是死设置；通道现在按目标主机自动选，不再需要手选。
          el('div', { class: 'muted', text: '通道按目标自动选择：走 GitHub 的一律代理优先（含 brew 官方源 formulae.brew.sh，它是 GitHub Pages），其余直连优先。换国内镜像源后对应地址自动走直连。' }),
          el('label', { class: 'check section' }, [chk, el('span', { text: '自动降级（首选通道失败时尝试另一通道）' })]),
        ]));

        // 缓存清理（自动清理开关默认开）
        const autoChk = el('input', { type: 'checkbox', checked: mk.autoCleanup !== false, on: { change: (e) => saveConfig({ autoCleanup: e.target.checked }, e.target.checked ? '已开启升级后自动清理缓存' : '已关闭升级后自动清理缓存') } });
        const cleanCard = ui.card('🧹 缓存清理', el('div', { class: 'card__rows' }, [
          el('label', { class: 'check' }, [autoChk, el('span', { text: '升级完成后自动清理缓存（brew cleanup --prune=all）' })]),
          el('div', { class: 'muted', text: '开启后，逐项升级任务结束时会自动执行一次清理（失败仅记日志，不影响升级结果）；关闭后需手动点击下方按钮。' }),
          el('div', { class: 'row section' }, [el('button', { class: 'btn', type: 'button', text: '🧹 立即清理缓存', on: { click: () => { ctx.runTask('brew', 'cleanup').catch(() => {}); } } })]),
        ]));

        // Homebrew 元数据自动同步（默认开）：启动后若元数据过期就自动 `brew update`（≈2s），
        // 让「可更新」重开即为真值；关掉后需手动点「重查可更新项」或「一键更新本体」。
        const metaChk = el('input', { type: 'checkbox', checked: mk.brewAutoRefreshMeta !== false, on: { change: (e) => saveConfig({ brewAutoRefreshMeta: e.target.checked }, e.target.checked ? '已开启启动时自动同步元数据' : '已关闭启动时自动同步元数据') } });
        const metaCard = ui.card('🔄 元数据同步', el('div', { class: 'card__rows' }, [
          el('label', { class: 'check' }, [metaChk, el('span', { text: '启动时自动同步 Homebrew 元数据（brew update，实测 1.7~3.2 秒）' })]),
          el('div', { class: 'muted', text: '元数据是「可更新 N 项」的判定依据，只由 brew update 刷新。开启后重开项目约 2 秒即为真值；关闭后该数字仅反映本机已有元数据，需手动点「重查可更新项」或「一键更新本体并刷新索引」。' }),
        ]));

        host.append(el('div', { class: 'grid grid--2' }, [portCard, chCard]), mirrorCard, cleanCard, metaCard, hintBox);
      }
      async function saveConfig(patch, msg) {
        try { config = await api('PUT', '/api/config', patch); ui.toast('ok', msg || '已保存'); draw(); } catch (err) { ui.toast('err', err.message || '保存失败'); }
      }
      async function savePorts(httpI, socksI) {
        const cur = config.brewgo || {};
        const ok = ui.portOk;
        const httpText = httpI.value.trim(), socksText = socksI.value.trim();
        // 非法或未变化一律 return，不提交：原先只 toast「已保持原值」，却仍无条件写入并再弹「端口已保存」。
        if (!ok(httpText) || !ok(socksText) || (Number(httpText) === cur.httpPort && Number(socksText) === cur.socksPort)) {
          ui.toast('warn', '端口未变化或输入非法，已保持原值');
          return;
        }
        const http = Number(httpText), socks = Number(socksText);
        await saveConfig({ proxy: { httpPort: http, socksPort: socks } }, `端口已保存：HTTP=${http} / SOCKS5=${socks}`);
        // 改端口后展示提示，不自动改 Git 代理
        hintBox.innerHTML = '';
        try {
          const e = await ctx.refreshEnv(true);
          const gp = e.git && e.git.httpProxy;
          const want = `http://127.0.0.1:${http}`;
          if (gp && gp !== want) hintBox.append(el('div', { class: 'warn-box section', text: `Git 全局代理仍为 ${gp}，如需同步请在系统初始化模块修改。` }));
          else if (!gp) hintBox.append(el('div', { class: 'warn-box section', text: `Git 全局代理未设置；如需使用请在系统初始化模块设为 ${want}。` }));
        } catch { /* 体检失败忽略 */ }
      }
      // 此处原先有 onPanel('config', draw)：全仓没有任何 emit('config')，该订阅永不触发（已删）。
      box.append(host); draw();
    }

    // ---------------- 面板注册 ----------------
    const panels = { upgrade: panelUpgrade, download: panelDownload, uninstall: panelUninstall, settings: panelSettings };

    /**
     * 面板级订阅：面板内部一律用 onPanel 代替 ctx.on。
     *
     * ctx.on 的解绑器只会被压进**视图级** subs（见 app.js makeCtx），而本视图切标签
     * 并不重挂视图 → 不自己回收就会一路累积：切 N 轮就有 N 份 'task'/'done'/'config'
     * 订阅，一个任务完成事件被触发 N 次（重复请求 outdated、提示重复弹）。
     * 这里在每次换面板前把上一份全部解绑。
     */
    function onPanel(ev, fn) { panelSubs.push(ctx.on(ev, fn)); }
    function releasePanelSubs() {
      for (const u of panelSubs) { try { u(); } catch { /* 已解绑 */ } }
      panelSubs.length = 0;
    }
    function renderPanel() {
      releasePanelSubs();
      panelBox.innerHTML = '';
      panels[active](panelBox);
    }

    ctx.on('env', () => { if (env) renderEnv(); });
    ctx.on('brewmeta', () => renderMetaSync());
    renderTabs(); renderMetaSync(); loadEnv(false);
    // 无条件首屏渲染（active 默认 'upgrade'）——不可依赖 active 判断，否则会整片空白。
    renderPanel();
    (async () => {
      try { config = await api('GET', '/api/config'); } catch { config = null; }
      // ★ 卸载后不要再 renderPanel()：那会在已分离的 DOM 上重新注册面板订阅
      //   （新解绑器进不了已遍历完的视图级 subs，事件总线会一直持有这些闭包）。
      if (!root.isConnected) return;
      if (active === 'settings') renderPanel();
    })();
  },

  unmount() {
    // 本实例的订阅（含面板级）由 app.js 在路由 teardown 时按实例统一回收；
    // 延时器回调用 root.isConnected 守卫兜底，故此处无需（也无法）操作 mount 局部变量。
  },
};
