/**
 * MacKit · M3 系统初始化（视图）
 *
 * 依据《MacKit-架构设计.md》§8.6 + 《MacKit-PRD.md》§6.4 / §3 M3 表 / §7.1，
 * 语义移植自原 `shell/proxy.sh`（参考脚本已于 2026-09-16 从仓库移除）。
 *
 * 设计要点：
 *   - 单一数据源：GET /api/sysinit/state（shell / alias / git / gitForm / tokenExists / proxyPorts）
 *   - ① 代理别名：现有 vs 将写入 逐行 diff（POST /api/sysinit/alias/preview）→ 二次确认 → apply_alias
 *     A2 明示：「移除」只删 alias proxy/unproxy 定义块，注释行保留；多行自定义版给黄灯提示。
 *   - ② Git 全局配置：默认值取自 state.gitForm（后端生成，前端不写死任何个人信息）；只提交变更项。
 *   - ③ GitHub 凭据：Token 输入 type=password，提交后立即清空；绝不回显 / 不写浏览器本地存储 / 不进日志。
 *   - ④ 代理端口：1–65535 校验（非法值不生效）；Q3：保存后仅展示提示，绝不自动改 Git 代理。
 */

/** 别名三选（与后端 apply_alias 的 mode 逐字一致） */
const ALIAS_MODES = [['keep', '保留原样'], ['replace', '覆盖更新'], ['remove', '移除别名']];

export default {
  id: 'sysinit',
  title: '系统初始化',

  mount(root, ctx) {
    const { el, ui, api } = ctx;
    const st = { data: null, gitInputs: new Map(), userInput: null, tokenInput: null, computeChanges: () => [], portHint: '' };
    const head = el('div', { class: 'view-head' });
    const body = el('div');
    root.append(head, body);

    // ============================ 数据加载 ============================
    async function load() {
      body.innerHTML = '';
      body.append(el('div', { class: 'view-loading', text: '正在读取系统状态…' }));
      try { st.data = await api('GET', '/api/sysinit/state'); }
      catch (err) { body.innerHTML = ''; body.append(el('div', { class: 'err-box', text: `读取失败：${err.message || err}` })); return; }
      render();
    }

    function render() {
      const d = st.data || {};
      const sh = d.shell || {};
      head.innerHTML = '';
      head.append(
        el('div', {}, [
          el('h1', { text: '系统初始化' }),
          el('div', { class: 'muted', text: `检测到 ${sh.kind || 'shell'}${sh.rcFile ? ' → 将操作 ' + sh.rcFile : '（未识别配置文件）'}` }),
        ]),
      );
      body.innerHTML = '';
      body.append(aliasSection(d.alias || {}), gitSection(d.gitForm || [], d.git || {}), tokenSection(d), portSection(d.proxyPorts || {}));
    }

    // ============================ ① 代理别名 ============================
    function aliasSection(al) {
      const nodes = [el('div', { class: 'card__rows' }, [
        ui.kv('配置文件', al.rcFile || '未识别'),
        ui.kv('现有别名', al.present ? (al.multiline ? '存在（多行自定义写法）' : '存在') : '未检测到'),
        ui.kv('与标准写法', al.matchesExpected ? '一致' : '不一致'),
      ])];
      if (al.present && !al.matchesExpected) {
        nodes.push(el('div', { class: 'warn-box section', text: '⚠ 现有别名与标准写法不同，已展示实际内容供你核对——不会被静默覆盖。' }));
        if (al.existing && al.existing.length) {
          nodes.push(el('div', {}, [
            el('div', { class: 'muted', text: '现有内容：' }),
            el('div', { class: 'diff' }, al.existing.map((l) => el('div', { class: 'diff__line' }, [el('span', { class: 'diff__same', text: l })]))),
          ]));
        }
      }
      nodes.push(el('div', { class: 'muted section', text: '写入前自动备份；「移除」仅删除 alias proxy= / alias unproxy= 两个定义块，注释行不会被删除（A2）。' }));
      const btns = el('div', { class: 'row' });
      for (const [m, label] of ALIAS_MODES) {
        btns.append(el('button', { class: `btn${m === 'keep' ? '' : m === 'replace' ? ' btn--primary' : ' btn--danger'}`, type: 'button', text: label, on: { click: () => onAlias(m) } }));
      }
      nodes.push(btns);
      const src = al.rcFile ? `source ${al.rcFile}` : '';
      nodes.push(el('div', { class: 'row section' }, [
        el('span', { class: 'muted', text: '生效命令：' }),
        el('code', { class: 'mono', text: src || '—' }),
        el('button', { class: 'btn btn--sm', type: 'button', text: '复制', on: { click: () => copy(src, '已复制生效命令') } }),
      ]));
      return ui.card('① 代理别名（proxy / unproxy）', el('div', {}, nodes), { light: al.matchesExpected ? 'ok' : 'warn' });
    }

    async function onAlias(mode) {
      if (mode === 'keep') { ui.toast('ok', '已选择「保留原样」，未做任何修改'); return; }
      let p;
      try { p = await api('POST', '/api/sysinit/alias/preview', { mode }); }
      catch (err) { ui.toast('err', err.message || '预览失败'); return; }
      const ok = await ui.confirmDialog({
        title: mode === 'replace' ? '确认覆盖更新代理别名' : '确认移除代理别名',
        confirmLabel: mode === 'replace' ? '覆盖更新' : '移除',
        body: el('div', {}, [
          el('div', { class: 'muted', text: `配置文件：${p.rcFile || '—'}` }),
          p.note ? el('div', { class: 'warn-box section', text: p.note }) : null,
          el('div', { class: 'muted section', text: '逐行差异（+ 新增 / − 删除）：' }),
          ui.diffView(p.diff || []),
        ]),
      });
      if (ok) await ctx.runTask('sysinit', 'apply_alias', { mode }, { confirm: true });
    }

    // ============================ ② Git 全局配置 ============================
    function gitSection(gitForm, git) {
      const rows = el('div', { class: 'card__rows' });
      st.gitInputs.clear();
      for (const f of gitForm) {
        const cur = f.current == null ? '' : String(f.current);
        const input = el('input', { type: 'text', value: cur, placeholder: f.placeholder || '', style: 'min-width:260px', on: { input: () => refreshGitHint() } });
        st.gitInputs.set(f.key, { input, current: cur, key: f.key });
        rows.append(el('div', { class: 'field__row' }, [
          el('span', { class: 'mono', style: 'width:160px', text: f.key }),
          input,
          el('span', { class: 'muted nowrap', text: `当前: ${cur === '' ? '未设置' : cur}` }),
        ]));
      }
      st.computeChanges = () => {
        const out = [];
        for (const rec of st.gitInputs.values()) { const v = rec.input.value.trim(); if (v !== rec.current) out.push({ key: rec.key, value: v }); }
        return out;
      };
      const hint = el('div', { class: 'muted section' });
      refreshGitHint = () => { const n = st.computeChanges().length; hint.textContent = n ? `将修改 ${n} 项 / 跳过 ${st.gitInputs.size - n} 项（值未变化）` : '无变更项（所有输入与当前值一致）'; };
      const card = ui.card('② Git 全局配置', el('div', {}, [
        el('div', { class: 'muted', text: '默认值来自系统建议（用户名由当前账号生成、邮箱留空、代理端口由当前配置拼出），可自行修改。' }),
        rows, hint,
        el('div', { class: 'row' }, [el('button', { class: 'btn btn--primary', type: 'button', text: '应用变更', on: { click: applyGit } })]),
      ]), { light: git.installed ? 'ok' : 'warn' });
      setTimeout(refreshGitHint, 0);
      return card;
    }
    let refreshGitHint = () => {};

    async function applyGit() {
      const changes = st.computeChanges();
      if (!changes.length) { ui.toast('warn', '没有需要应用的变更项（所有输入与当前值一致）'); return; }
      const ok = await ui.confirmDialog({
        title: `确认应用 Git 全局配置（${changes.length} 项）`, confirmLabel: '应用变更',
        body: el('div', {}, [
          el('p', { text: '将执行：' }),
          el('ul', {}, changes.map((c) => el('li', { class: 'mono', text: `git config --global ${c.key} ${c.value}` }))),
          el('p', { class: 'muted', text: `跳过 ${st.gitInputs.size - changes.length} 项（值未变化）` }),
        ]),
      });
      if (ok) await ctx.runTask('sysinit', 'apply_git_config', { changes }, { confirm: true });
    }

    // ============================ ③ GitHub 凭据 ============================
    function tokenSection(d) {
      st.userInput = el('input', { type: 'text', placeholder: 'GitHub 用户名', style: 'min-width:180px', autocomplete: 'off' });
      st.tokenInput = el('input', { type: 'password', placeholder: 'ghp_…（不会回显）', style: 'min-width:240px', autocomplete: 'off' });
      const steps = el('ol', { class: 'card__rows muted' }, [
        el('li', { text: '1. 打开 GitHub 设置 → Developer settings' }),
        el('li', { text: '2. Personal access tokens → Tokens (classic) → Generate new token' }),
        el('li', { text: '3. 勾选 repo 权限' }),
        el('li', { text: '4. 生成并复制以 ghp_ 开头的字符串' }),
      ]);
      const btn = el('button', {
        class: 'btn btn--primary', type: 'button', text: '写入钥匙串',
        on: {
          click: async () => {
            const username = st.userInput.value.trim();
            const token = st.tokenInput.value;
            if (!username || !token) { ui.toast('warn', '请填写用户名与 Token'); return; }
            const ok = await ui.confirmDialog({
              title: '确认写入 GitHub 凭据', confirmLabel: '写入钥匙串',
              body: el('div', {}, [
                el('p', { text: `用户名：${username}` }),
                el('p', { class: 'muted', text: 'Token 将仅写入 macOS 钥匙串（git credential-osxkeychain），不落盘、不进日志。' }),
              ]),
            });
            if (!ok) return;
            await ctx.runTask('sysinit', 'store_token', { username, token }, { confirm: true });
            st.tokenInput.value = ''; // 提交后立即清空，绝不回显 / 不落浏览器本地存储
          },
        },
      });
      return ui.card('③ GitHub 凭据', el('div', {}, [
        el('div', { class: 'muted', text: d.tokenExists ? '状态：🟢 检测到已有凭据' : '状态：⚠ 凭据缺失' }),
        steps,
        el('div', { class: 'field__row section' }, [
          el('span', { class: 'muted', style: 'width:72px', text: '用户名' }), st.userInput,
          el('span', { class: 'muted', style: 'width:64px', text: 'Token' }), st.tokenInput, btn,
        ]),
        el('div', { class: 'muted', text: '🔒 Token 仅写入 macOS 钥匙串，不落盘、不经过任何配置文件；提交后输入框立即清空。' }),
      ]), { light: d.tokenExists ? 'ok' : 'warn' });
    }

    // ============================ ④ 代理端口 ============================
    function portSection(pp) {
      const httpI = el('input', { type: 'number', min: '1', max: '65535', value: String(pp.http == null ? '' : pp.http), style: 'max-width:140px' });
      const socksI = el('input', { type: 'number', min: '1', max: '65535', value: String(pp.socks5 == null ? '' : pp.socks5), style: 'max-width:140px' });
      const btn = el('button', {
        class: 'btn btn--primary', type: 'button', text: '保存端口',
        on: {
          click: async () => {
            const okInt = (v) => /^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
            const bad = !okInt(httpI.value.trim()) || !okInt(socksI.value.trim());
            const h = okInt(httpI.value.trim()) ? Number(httpI.value) : pp.http;
            const s = okInt(socksI.value.trim()) ? Number(socksI.value) : pp.socks5;
            if (bad) ui.toast('warn', '非法端口输入已忽略并保持原值（需 1–65535 的整数）');
            st.portHint = '';
            await ctx.runTask('sysinit', 'set_proxy_ports', { httpPort: h, socksPort: s });
            // Q3：保存后仅展示提示，绝不自动调用 apply_git_config
            try {
              const e = await ctx.refreshEnv(true);
              const gp = e.git && e.git.httpProxy;
              const want = `http://127.0.0.1:${h}`;
              if (gp && gp !== want) st.portHint = `Git 全局代理仍为 ${gp}，如需同步请在下方 Git 配置中修改`;
              else if (!gp) st.portHint = `Git 全局代理未设置；如需使用请在下方 Git 配置中设为 ${want}`;
            } catch { /* 体检失败忽略 */ }
            render();
          },
        },
      });
      return ui.card('④ 代理端口', el('div', {}, [
        el('div', { class: 'field__row' }, [el('span', { class: 'muted', style: 'width:120px', text: 'HTTP 端口' }), httpI]),
        el('div', { class: 'field__row section' }, [el('span', { class: 'muted', style: 'width:120px', text: 'SOCKS5 端口' }), socksI]),
        el('div', { class: 'muted', text: '非纯数字或超出 1–65535 的输入将被忽略并保持原值（对齐原脚本语义）。' }),
        el('div', { class: 'row section' }, [btn]),
        st.portHint ? el('div', { class: 'warn-box section', text: st.portHint }) : null,
      ]));
    }

    // ============================ 工具 ============================
    async function copy(text, msg) {
      if (!text) return;
      try { await navigator.clipboard.writeText(text); ui.toast('ok', msg || '已复制'); }
      catch { ui.toast('warn', '复制失败，请手动选择'); }
    }

    // 任务结束后刷新状态（别名 / Git / Token 状态可能变化）
    ctx.on('done', (t) => { if (t && t.module === 'sysinit') load(); });

    load();
  },

  unmount() { /* 订阅由 app.js 统一回收 */ },
};
