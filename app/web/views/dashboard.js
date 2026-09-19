/**
 * MacKit · 总览（Dashboard）
 *
 *   - 环境体检卡网格（与 Homebrew 页的环境卡同源：GET /api/env）
 *   - 状态灯三色；"代理别名与期望格式不一致"必须为 🟡 + 说明
 *   - 空态：可更新为 0 → 「🎉 所有 Homebrew 软件包均为最新」；tapEmpty → 专门解释文案
 *
 * 本视图只读；一切任务状态以后端为准。
 */

export default {
  id: 'dashboard',
  title: '总览',

  mount(root, ctx) {
    const { el, ui } = ctx;
    const grid = el('div', { class: 'grid grid--2 section' });
    // 「上次体检」时间戳：每次成功刷新后更新，让用户能确认体检真的跑过一次
    const envCheckedAt = el('span', { class: 'view-head__meta' });
    // MacKit 自身更新按钮（状态由 /api/selfupdate/status 驱动）
    const updBtn = el('button', { class: 'btn', type: 'button', text: '检查 MacKit 更新', on: { click: () => onUpdate() } });

    const head = el('div', { class: 'view-head' }, [
      el('div', {}, [el('h1', { text: '总览' }), el('div', { class: 'muted', text: '环境体检' })]),
      el('div', { class: 'row' }, [
        envCheckedAt,
        el('button', { class: 'btn btn--ghost', type: 'button', text: '⟳ 重新体检', on: { click: () => load(true) } }),
        updBtn,
      ]),
    ]);
    root.append(head, grid);

    function lightOf(st) { return ['ok', 'warn', 'error'].includes(st) ? st : 'warn'; }
    function netRows(label, p) {
      const rows = [ui.kv(`${label}连通`, p && p.ok ? '🟢 正常' : '🔴 不可达')];
      if (p && p.ok) rows.push(ui.kv(`${label}出口 IP`, [p.ip || 'IP 信息获取失败', p.location ? ` · ${p.location}` : ''].join('')));
      return rows;
    }

    // DeepSeek Harness 卡片：数据源是独立的 /api/dsh/status（env 快照里已不再包含 dsh），
    // 与体检渲染解耦 —— 用持久容器 dshHost，体检重渲染时只把它挂回网格。
    const dshHost = el('div');
    let dshState = { loading: true, data: null, error: null };

    function renderDsh() {
      dshHost.innerHTML = '';
      const { loading, data: dh, error } = dshState;
      if (loading) {
        dshHost.append(ui.card('🐋 DeepSeek Harness', el('div', { class: 'view-loading', text: '正在读取 DSH 状态…' })));
        return;
      }
      if (error || !dh) {
        // 读取失败不抛错：给出明确文案并保留「前往安装」入口
        dshHost.append(ui.card('🐋 DeepSeek Harness', el('div', { class: 'card__rows' }, [
          el('div', { class: 'warn-box', text: '未能读取 DSH 状态' }),
          el('button', { class: 'btn btn--sm', type: 'button', text: '前往安装 →', on: { click: () => ctx.navigate('#/dsh') } }),
        ]), { light: 'warn' }));
        return;
      }
      const dhDsh = dh.dsh || {};
      const dhNode = dh.node || {};
      const dhMarket = dh.market || {};
      const dshRows = el('div', { class: 'card__rows' }, [
        ui.kv('dsh', dhDsh.installed ? `${dhDsh.version || '已安装'}` : '未安装'),
        ui.kv('Node.js / npm', `${dhNode.installed ? (dhNode.version || '✓') : '未检测到'} · ${(dh.npm && dh.npm.installed) ? 'npm ✓' : 'npm ✗'}`),
        ui.kv('插件市场', dhMarket.installed ? `已安装${dhMarket.version ? ' v' + dhMarket.version : ''}` : '未安装（可选）'),
      ]);
      if (!dhDsh.installed) {
        dshRows.append(el('div', { class: 'warn-box', text: '未检测到 DeepSeek Harness（dsh）。可在该模块里一键安装，并自行决定是否同时装插件市场。' }));
        dshRows.append(el('button', { class: 'btn btn--sm', type: 'button', text: '前往安装 →', on: { click: () => ctx.navigate('#/dsh') } }));
      }
      dshHost.append(ui.card('🐋 DeepSeek Harness', dshRows, { light: dhDsh.installed ? 'ok' : 'warn' }));
    }

    async function loadDsh() {
      dshState = { loading: true, data: null, error: null };
      renderDsh();
      try { dshState = { loading: false, data: await ctx.api('GET', '/api/dsh/status'), error: null }; }
      catch (err) { dshState = { loading: false, data: null, error: err }; }
      renderDsh();
    }

    function render(e) {
      grid.innerHTML = '';
      const b = e.brew || {}, n = e.network || {}, sh = e.shell || {}, rm = e.rime || {}, g = e.git || {}, m = e.mirror || {}, pp = e.proxyPorts || {};
      envCheckedAt.textContent = e.checkedAt ? `上次检查 ${ctx.fmtTime(e.checkedAt)}` : '';

      // Homebrew
      const outdated = (b.outdatedFormula || 0) + (b.outdatedCask || 0);
      const brewRows = el('div', { class: 'card__rows' }, [
        ui.kv('版本', b.version || '未检测到'),
        ui.kv('路径', el('span', { class: 'mono', text: b.path || '—' })),
        ui.kv('已安装', `formula ${b.formulaCount || 0} / cask ${b.caskCount || 0}`),
        ui.kv('可更新', outdated > 0 ? `${outdated} 项` : '0 项'),
      ]);
      if (outdated === 0) brewRows.append(el('div', { class: 'empty', style: 'padding:12px' }, [el('div', { class: 'empty__title', text: '🎉 所有 Homebrew 软件包均为最新' }), el('div', { class: 'muted', text: '无需更新' })]));
      if (b.tapEmpty) brewRows.append(el('div', { class: 'muted', text: 'ℹ Homebrew 7 默认不再显式列出 core / cask 等内置源，属正常现象。' }));
      grid.append(ui.card('🍺 Homebrew', brewRows, { light: lightOf(b.status) }));

      // 网络
      grid.append(ui.card('🌐 网络', el('div', { class: 'card__rows' }, [
        ...netRows('直连', n.direct), ...netRows('代理', n.proxy),
        n.allFailed ? el('div', { class: 'err-box', text: '直连与代理均不可用，请检查网络或代理端口配置。' }) : null,
      ].filter(Boolean)), { light: lightOf(n.status) }));

      // Shell / 别名
      const aliasOk = sh.aliasPresent && sh.aliasMatchesExpected;
      const aliasText = !sh.aliasPresent ? '未设置' : (sh.aliasMatchesExpected ? '已配置且与期望一致' : '已有自定义别名，与期望格式不一致');
      const shellRows = el('div', { class: 'card__rows' }, [
        ui.kv('Shell', `${sh.kind || 'unknown'} · ${sh.rcFile || '未识别'}`),
        ui.kv('proxy 别名', aliasOk ? '🟢 ' + aliasText : '🟡 ' + aliasText),
      ]);
      if (sh.aliasPresent && !sh.aliasMatchesExpected) {
        shellRows.append(el('div', { class: 'warn-box', text: '检测到 rc 文件中已有自定义 proxy/unproxy 别名（格式与本应用期望不同）。请前往「系统初始化」查看并排 diff 后三选一处理，本应用不会盲目追加。' }));
        shellRows.append(el('button', { class: 'btn btn--sm', type: 'button', text: '前往系统初始化 →', on: { click: () => ctx.navigate('#/sysinit') } }));
      }
      const shellLight = sh.kind === 'unknown' ? 'warn' : ((sh.aliasPresent && sh.aliasMatchesExpected) ? lightOf(sh.status) : 'warn');
      grid.append(ui.card('🐚 Shell', shellRows, { light: shellLight }));

      // Rime
      const rimeRows = el('div', { class: 'card__rows' }, [
        ui.kv('目录', `${rm.dir || '—'} ${rm.dirExists ? '✓' : '✗'}`),
        ui.kv('plum / 主方案 / Squirrel', `${rm.plumExists ? '✓' : '✗'} · ${rm.mainSchemaExists ? '✓' : '✗'} · ${rm.squirrelDeployable ? '可部署 ✓' : '不可自动部署 ✗'}`),
        ui.kv('当前皮肤', rm.currentSkin || '未知'),
        ui.kv('当前布局', rm.currentLayout ? `${rm.currentLayout} · ${rm.currentOrientation || ''}` : '未知'),
      ]);
      if (!rm.mainSchemaExists) rimeRows.append(el('div', { class: 'warn-box', text: '⚠ 未检测到主方案 rime_ice.schema.yaml，请先执行「安装 / 更新词库」。' }));
      grid.append(ui.card('🀄 Rime', rimeRows, { light: lightOf(rm.status) }));

      // Git
      grid.append(ui.card('📦 Git', el('div', { class: 'card__rows' }, [
        ui.kv('user.name', g.userName || '未设置'),
        ui.kv('user.email', g.userEmail || '未设置'),
        ui.kv('凭据', g.tokenExists ? '已存在' : '缺失'),
      ]), { light: lightOf(g.status) }));

      // 镜像源 / 代理
      grid.append(ui.card('⚙ 镜像源 / 代理', el('div', { class: 'card__rows' }, [
        ui.kv('镜像源', m.label || m.id || '—'),
        ui.kv('代理端口', `${pp.http || '—'} (HTTP) / ${pp.socks5 || '—'} (SOCKS5)`),
        ui.kv('配置文件', el('span', { class: 'mono', text: pp.configPath || '—' })),
      ]), { light: lightOf(m.status) }));

      // DeepSeek Harness（独立数据源 /api/dsh/status；env 快照已无 dsh）
      grid.append(dshHost);
      renderDsh();
    }

    async function load(force) {
      grid.innerHTML = '';
      grid.append(el('div', { class: 'view-loading', text: '正在体检…' }));
      envCheckedAt.textContent = '正在体检…';
      try {
        // refreshEnv 内部 emit('env') → 下面的订阅会渲染网格，这里不再显式 render()（避免重复渲染）
        await ctx.refreshEnv(force);
        envCheckedAt.textContent = `上次体检 ${ctx.fmtTime(Date.now())}`;
      } catch (err) {
        grid.innerHTML = '';
        grid.append(el('div', { class: 'err-box', text: `体检失败：${err.message || err}` }));
        envCheckedAt.textContent = '';
      }
    }

    // ============================ MacKit 自身更新 ============================
    // 状态：未检查 / 检查中 / 已是最新（禁用）/ 有新提交（可点）/ 非 git 检出（禁用）/ 检查失败
    let updateState = null;

    function syncUpdateBtn() {
      const s = updateState;
      updBtn.className = 'btn';
      updBtn.title = '';
      if (!s || s.checking) { updBtn.textContent = '检查 MacKit 更新…'; updBtn.disabled = true; return; }
      if (!s.managed) {
        updBtn.textContent = '无法自动更新';
        updBtn.disabled = true;
        updBtn.title = '当前目录不是 git 检出（可能是 ZIP 下载的），请到 GitHub 重新下载最新版';
        return;
      }
      if (s.behind > 0) {
        updBtn.textContent = `更新 MacKit（${s.behind} 个新提交）`;
        updBtn.className = 'btn btn--primary';
        updBtn.disabled = false;
        updBtn.title = [s.latest && s.latest.subject, s.latest && s.latest.commit].filter(Boolean).join(' · ');
        return;
      }
      if (s.behind === 0) {
        updBtn.textContent = '已是最新';
        updBtn.disabled = true;
        updBtn.title = `已与 ${s.upstream || '远端'} 同步${s.checkedAt ? `（${ctx.fmtTime(s.checkedAt)} 检查）` : ''}`;
        return;
      }
      // behind === null：没查到（fetch 失败 / 网络问题）
      updBtn.textContent = '检查更新';
      updBtn.disabled = false;
      updBtn.title = s.fetchError ? `上次检查失败：${s.fetchError}` : '点一下去远端查有没有新提交';
    }

    async function loadUpdate(force) {
      updateState = { checking: true };
      syncUpdateBtn();
      try { updateState = await ctx.api('GET', `/api/selfupdate/status${force ? '?force=1' : ''}`); }
      catch (err) { updateState = { managed: true, behind: null, fetchError: err.message || String(err) }; }
      syncUpdateBtn();
    }

    async function onUpdate() {
      const s = updateState || {};
      const hasNew = typeof s.behind === 'number' && s.behind > 0;
      const ok = await ui.confirmDialog({
        title: hasNew ? `确认更新 MacKit（${s.behind} 个新提交）` : '确认检查并更新 MacKit',
        confirmLabel: hasNew ? '开始更新' : '检查并更新',
        body: el('div', {}, [
          el('p', { text: hasNew ? '将通过 git 拉取最新代码：' : '会先 fetch 比较，没有新提交就什么都不改；有则执行：' }),
          el('ol', { class: 'card__rows mono' }, [
            el('li', { text: 'git fetch --prune origin' }),
            el('li', { text: 'git pull --ff-only' }),
          ]),
          el('p', { class: 'muted', text: '只用 --ff-only：不会产生 merge commit，也不会 stash / 丢弃你的本地改动。更新后需要重启 MacKit 服务。' }),
          s.dirty > 0 ? el('div', { class: 'warn-box', text: `⚠ 当前有 ${s.dirty} 处未提交改动；若与本次更新冲突，git 会拒绝，工作区保持原样。` }) : null,
        ]),
      });
      if (!ok) return;
      try { await ctx.runTask('selfupdate', 'update', {}, { confirm: true }); }
      catch { /* runTask 内部已提示 */ }
      loadUpdate(true);
    }

    ctx.on('env', (e) => render(e)); // 订阅由 app.js 在视图卸载时统一回收
    load(false);
    loadDsh();
    loadUpdate(false);
  },

  unmount() { /* 订阅由 app.js 统一回收 */ },
};
