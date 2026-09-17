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

    const head = el('div', { class: 'view-head' }, [
      el('div', {}, [el('h1', { text: '总览' }), el('div', { class: 'muted', text: '环境体检' })]),
      el('div', { class: 'row' }, [
        envCheckedAt,
        el('button', { class: 'btn btn--ghost', type: 'button', text: '⟳ 重新体检', on: { click: () => load(true) } }),
      ]),
    ]);
    root.append(head, grid);

    function lightOf(st) { return ['ok', 'warn', 'error'].includes(st) ? st : 'warn'; }
    function netLight(p) { return p && p.ok ? 'ok' : 'error'; }
    function netRows(label, p) {
      const rows = [ui.kv(`${label}连通`, p && p.ok ? '🟢 正常' : '🔴 不可达')];
      if (p && p.ok) rows.push(ui.kv(`${label}出口 IP`, [p.ip || 'IP 信息获取失败', p.location ? ` · ${p.location}` : ''].join('')));
      return rows;
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
    }

    async function load(force) {
      grid.innerHTML = '';
      grid.append(el('div', { class: 'view-loading', text: '正在体检…' }));
      envCheckedAt.textContent = '正在体检…';
      try {
        render(await ctx.refreshEnv(force));
        envCheckedAt.textContent = `上次体检 ${ctx.fmtTime(Date.now())}`;
      } catch (err) {
        grid.innerHTML = '';
        grid.append(el('div', { class: 'err-box', text: `体检失败：${err.message || err}` }));
        envCheckedAt.textContent = '';
      }
    }

    ctx.on('env', (e) => render(e)); // 订阅由 app.js 在视图卸载时统一回收
    load(false);
  },

  unmount() { /* 订阅由 app.js 统一回收 */ },
};
