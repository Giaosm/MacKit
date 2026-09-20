/**
 * MacKit · DeepSeek Harness（视图）
 *
 *   - 单一数据源：GET /api/dsh/status（与总览体检卡同源，后端唯一实现见 lib/dsh.js queryStatus）
 *   - 安装：宿主 install_dsh 与插件市场 add_market 是**两个独立按钮**；
 *     插件市场一旦装好，按钮变「已安装」并禁用（按设计不重复安装 / 更新，要更新去终端）
 *   - 本视图只管安装：dsh web 是长驻服务，MacKit 不代跑，装完请自己在终端执行
 *
 * 危险动作（npm 全局安装 / 改 profile）一律先弹确认框，并显示即将执行的命令。
 */

/** 兜底命令文案（后端未就绪时仍能正确展示） */
const FALLBACK_CMDS = {
  install: 'npm install -g @deepseek-ai/dsh',
  pnpm: 'npm install -g pnpm',
  market: 'dsh plugin --profile web add dshmarket',
};

export default {
  id: 'dsh',
  title: 'DeepSeek Harness',

  mount(root, ctx) {
    const { el, ui, api } = ctx;
    const st = { data: null };
    const head = el('div', { class: 'view-head' });
    const body = el('div');
    root.append(head, body);

    // ============================ 数据加载 ============================
    async function load() {
      body.innerHTML = '';
      body.append(el('div', { class: 'view-loading', text: '正在检测 DeepSeek Harness 环境…' }));
      try { st.data = await api('GET', '/api/dsh/status'); }
      catch (err) {
        body.innerHTML = '';
        body.append(el('div', { class: 'err-box', text: `检测失败：${err.message || err}` }));
        return;
      }
      render();
    }

    function render() {
      const d = st.data || {};
      const cmds = { ...FALLBACK_CMDS, ...(d.commands || {}) };
      const dshInstalled = !!(d.dsh && d.dsh.installed);
      head.innerHTML = '';
      head.append(
        el('div', {}, [
          el('h1', { text: 'DeepSeek Harness' }),
          el('div', { class: 'muted', text: '安装 dsh 宿主与（可选）插件市场 · 装完在终端执行 dsh web' }),
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'view-head__meta', text: dshInstalled ? `dsh ${(d.dsh && d.dsh.version) || ''}` : '未安装' }),
          el('button', { class: 'btn btn--ghost', type: 'button', text: '⟳ 重新检测', on: { click: () => load() } }),
        ]),
      );
      body.innerHTML = '';
      body.append(
        statusCard(d),
        installCard(d, cmds),
      );
    }

    // ============================ ① 环境状态 ============================
    function statusCard(d) {
      const node = d.node || {};
      const npm = d.npm || {};
      const pnpm = d.pnpm || {};
      const dsh = d.dsh || {};

      const rows = el('div', { class: 'card__rows' }, [
        ui.kv('Node.js', node.installed ? `${node.version || '已安装'} · ${node.path || ''}` : '未检测到（DSH 需要 Node 20+）'),
        ui.kv('npm', npm.installed ? `${npm.version || '已安装'}` : '未检测到'),
        ui.kv('npm 全局目录', npm.prefix
          ? el('span', {}, [`${npm.prefix}`, npm.prefixWritable ? '（可写）' : '（不可写 ⚠）'])
          : '—'),
        ui.kv('pnpm', pnpm.installed ? `${pnpm.version || '已安装'}${pnpm.path ? ' · ' + pnpm.path : ''}` : '未安装（插件市场才需要）'),
        ui.kv('dsh', dsh.installed ? `${dsh.version || '已安装'} · ${dsh.path || ''}` : '未安装'),
        ui.kv('DSH_HOME', dsh.home || '—'),
        ui.kv('web profile', dsh.profileExists ? `${dsh.profile}` : `${dsh.profile || '—'}（尚未初始化，安装插件时自动创建）`),
      ]);

      if (!node.installed) {
        rows.append(el('div', { class: 'warn-box', text: '⚠ 未检测到 Node.js。已装 Homebrew 时可在「Homebrew 管家」里安装 formula：node；否则到 https://nodejs.org 下载。' }));
        rows.append(el('button', { class: 'btn btn--sm', type: 'button', text: '前往 Homebrew 管家 →', on: { click: () => ctx.navigate('#/brew') } }));
      } else if (node.major !== null && node.major < 20) {
        rows.append(el('div', { class: 'warn-box', text: `⚠ 当前 Node ${node.version} 低于 DSH 要求的 20，建议先升级。` }));
      }
      if (node.installed && !npm.installed) {
        rows.append(el('div', { class: 'warn-box', text: '⚠ 未检测到 npm。用 nvm / fnm 装的 Node，请从终端启动 MacKit（app/MacKit.command）以继承你的 PATH。' }));
      }
      if (npm.installed && npm.prefixWritable === false) {
        rows.append(el('div', { class: 'warn-box', text: `⚠ npm 全局目录不可写（${npm.prefix}）：需改用 Homebrew 装的 Node，或 npm config set prefix ~/.npm-global 并把它的 bin 加入 PATH。` }));
      }

      return ui.card('① 环境状态', rows, { light: dsh.installed ? 'ok' : 'warn' });
    }

    // ============================ ② 安装 / 更新 ============================
    function installCard(d, cmds) {
      const node = d.node || {};
      const npm = d.npm || {};
      const dsh = d.dsh || {};
      const market = d.market || {};
      const dshInstalled = !!dsh.installed;
      const marketInstalled = !!market.installed;
      // Node / npm / 全局目录任一不满足：两个按钮都点不动（后端每步还会再拦一次）
      const ready = !!node.installed && !!npm.installed && npm.prefixWritable !== false;

      // 宿主按钮：未装 →「安装」；装了但已是最新 → 禁用；registry 上有新版 → 解禁并变「更新到 x.y.z」
      const host = hostButtonState(dsh);
      const dshBtn = el('button', {
        class: 'btn btn--primary', type: 'button',
        text: host.text,
        title: host.title,
        on: { click: () => installDsh(cmds, dshInstalled) },
      });
      dshBtn.disabled = !ready || host.disabled;

      // 插件市场：装过即锁定，不提供「再次安装 / 更新」（要更新请到终端执行）
      const marketBtn = el('button', {
        class: 'btn', type: 'button',
        text: marketInstalled ? '已安装' : '安装',
        on: { click: () => installMarket(cmds) },
      });
      marketBtn.disabled = marketInstalled || !dshInstalled || !ready;

      return ui.card('② 安装 / 更新', el('div', { class: 'card__rows' }, [
        actionRow('@deepseek-ai/dsh', hostStatus(dsh), dshBtn),
        actionRow(marketName(d), marketInstalled
          ? `已安装${market.version ? ' v' + market.version : ''}（不再重复安装）`
          : (dshInstalled ? '未安装（可选）' : '需先安装 dsh 宿主'), marketBtn),
        !ready ? el('div', { class: 'warn-box', text: '⚠ 环境未就绪（缺少 Node / npm，或 npm 全局目录不可写），请先按「环境状态」里的提示处理。' }) : null,
      ]), { light: dshInstalled ? 'ok' : 'warn' });
    }

    /**
     * 宿主按钮的三种状态（就是需求里那条规则）：
     *   未安装            →「安装」，可点
     *   已安装且是最新     →「已是最新」，禁用
     *   有更新 / 查不到版本 →「更新到 x.y.z」/「重新安装 / 更新」，可点
     * 查不到（离线、被墙）时不能谎报「已是最新」，所以退回可点的重装按钮。
     */
    function hostButtonState(dsh) {
      if (!dsh.installed) return { text: '安装', disabled: false, title: '' };
      if (dsh.updateAvailable && dsh.latestVersion) {
        return { text: `更新到 ${dsh.latestVersion}`, disabled: false, title: `本地 ${dsh.version || '未知'} → registry 上最新 ${dsh.latestVersion}` };
      }
      if (!dsh.latestVersion) {
        return { text: '重新安装 / 更新', disabled: false, title: '未能连接到 npm registry，无法确认是否已是最新；点这里可直接重新安装 / 更新' };
      }
      return { text: '已是最新', disabled: true, title: `本地 ${dsh.version || ''} 已是 registry 上的最新版` };
    }

    /** 宿主那一行的状态文案。 */
    function hostStatus(dsh) {
      if (!dsh.installed) return '未安装';
      const ver = `已安装 ${dsh.version || ''}`.trim();
      if (dsh.updateAvailable) return `${ver} · 有新版本 ${dsh.latestVersion}`;
      if (!dsh.latestVersion) return `${ver} · 未能检查更新`;
      return ver;
    }

    /** 一行「名称 + 状态 + 操作按钮」。 */
    function actionRow(name, status, btn) {
      return el('div', { class: 'row row--between' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'mono', text: name }),
          el('span', { class: 'muted', text: status }),
        ]),
        btn,
      ]);
    }

    /** 插件市场包名（后端下发为准，缺省回落常量）。 */
    function marketName(d) {
      return (d.market && d.market.packageName) || 'dshmarket';
    }

    /** 安装 / 更新宿主（与插件市场完全独立）。 */
    async function installDsh(cmds, dshInstalled) {
      const ok = await ui.confirmDialog({
        title: dshInstalled ? '确认重新安装 / 更新 DeepSeek Harness' : '确认安装 DeepSeek Harness',
        confirmLabel: dshInstalled ? '重新安装 / 更新' : '开始安装',
        body: el('div', {}, [
          el('p', { text: '将执行（全局安装；走代理优先、失败自动降级）：' }),
          el('ol', { class: 'card__rows mono' }, [el('li', { text: cmds.install })]),
        ]),
      });
      if (!ok) return;
      try { await ctx.runTask('dsh', 'install_dsh', {}, { confirm: true }); }
      catch { /* runTask 内部已提示 */ }
      // 不在此处再 load()：done 订阅已刷新状态，否则一次安装会发两次 /api/dsh/status。
    }

    /** 安装插件市场（需要 dsh 与 pnpm；pnpm 缺失会自动安装）。 */
    async function installMarket(cmds) {
      const ok = await ui.confirmDialog({
        title: '确认安装插件市场',
        confirmLabel: '开始安装',
        body: el('div', {}, [
          el('p', { text: '将依次执行：' }),
          el('ol', { class: 'card__rows mono' }, [cmds.pnpm, cmds.market].map((c) => el('li', { text: c }))),
          el('p', { class: 'muted', text: '插件装在 ~/.dsh/profiles/web 下；装好后在 dsh web 里：Settings → Plugin Market。' }),
        ]),
      });
      if (!ok) return;
      try { await ctx.runTask('dsh', 'add_market', {}, { confirm: true }); }
      catch { /* runTask 内部已提示 */ }
      // 同上：done 订阅已刷新，去掉 await 后的重复 load()。
    }

    // 任务结束后刷新状态（dsh / pnpm / 插件市场是否就位）
    ctx.on('done', (t) => { if (t && t.module === 'dsh') load(); });

    load();
  },

  unmount() { /* 订阅由 app.js 统一回收 */ },
};
