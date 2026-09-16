/**
 * MacKit · M4 Rime 输入法（视图）
 *
 * 依据《MacKit-架构设计.md》§8.6 / §3.9 / §7 T05 + 《MacKit-PRD.md》§6.5 / §3 M4，
 * 语义移植自原 `shell/rime_ice.sh`（参考脚本已于 2026-09-16 从仓库移除）。
 *
 * 契约：
 *   - GET /api/rime/status      → 11 字段状态（rimeDir/dirExists/plumExists/mainSchemaExists/
 *                                 squirrelDeployable/squirrelBin/currentSkin/currentLayout/currentOrientation/skinSource/status）
 *   - GET /api/rime/skins       → SkinResult { schemes:[22 SkinEntry], source }
 *   - GET /api/rime/appearance  → { status, current, currentSchema, schemes:[8 输入方案],
 *                                 layouts:[4 布局], skinSource, grammarModels:[{name,size}],
 *                                 grammarApplied:[schemaId…] }
 *   - 语法模型三动作分离：install_grammar（仅下载模型） / apply_grammar / remove_grammar（写/删 ${schema}.custom.yaml，destructive 需确认）
 *   - GET /api/rime/upstream    → { localVersion, localSyncedAt, upstreamLatest:{date,title}, upToDate, remoteError, checkedAt }
 *   - 8.1：色值一律用服务端归一化的 {hex, alpha}；前端**只做 rgba() 合成**，不重复解析 AARRGGBB。
 *   - A3：hasColors=false（native）→ colors=null → 中性色兜底，不报错、不丢卡。
 *   - 输入方案无切换入口（2026-09-16 删除，F4 选单由 Rime 记住选择）；当前方案在状态卡只读展示。联网固定代理优先。
 */

/** 联网策略固定为「代理优先」：后端 netPolicy 缺省 proxy_first，失败自动降级直连，前端不再提供通道选择。 */
/** Squirrel 皮肤来源标签 */
const SOURCE_LABEL = { squirrel: 'squirrel.yaml', build: 'build/squirrel.yaml', degraded: '降级（仅名称）' };

export default {
  id: 'rime',
  title: 'Rime 输入法',

  mount(root, ctx) {
    const { el, ui, api } = ctx;
    const S = { status: null, skins: null, appearance: null, skin: null, layoutIdx: null, grammarScheme: 'rime_ice', upstream: null, checkingUpstream: false };
    const head = el('div', { class: 'view-head' });
    const body = el('div');
    root.append(head, body);

    // ============================ 数据 ============================
    async function load() {
      body.innerHTML = '';
      body.append(el('div', { class: 'view-loading', text: '正在读取 Rime 状态…' }));
      try {
        const [status, skins, appearance] = await Promise.all([
          api('GET', '/api/rime/status'), api('GET', '/api/rime/skins'), api('GET', '/api/rime/appearance'),
        ]);
        S.status = status; S.skins = skins; S.appearance = appearance;
        // 预选当前皮肤（apathy）与当前布局（linear/horizontal → 第 2 项）；必须在 try 内使用三个 const
        if (S.skin == null && status.currentSkin) S.skin = status.currentSkin;
        if (S.layoutIdx == null) S.layoutIdx = layoutIndexOf(appearance.layouts, status.currentLayout, status.currentOrientation);
        render();
      } catch (err) {
        body.innerHTML = '';
        body.append(el('div', { class: 'err-box', text: `读取失败：${err.message || err}` }));
      }
    }
    const gated = () => !!(S.status && S.status.mainSchemaExists === false);     // 主方案缺失 → 置灰

    // ============================ 渲染 ============================
    function render() {
      head.innerHTML = '';
      head.append(
        el('div', {}, [el('h1', { text: 'Rime 输入法' }), el('div', { class: 'muted', text: '词库 · 方案 · 语法模型 · 外观' })]),
        el('button', { class: 'btn', type: 'button', text: '⟳ 重新检测', on: { click: load } }),
      );
      body.innerHTML = '';
      body.append(statusCard(), vocabCard(), grammarCard(), skinGrid(), appearanceCard());
    }

    function statusCard() {
      const s = S.status || {};
      const lights = [
        ['Rime 目录', !!s.dirExists, s.rimeDir || '~/Library/Rime'],
        ['plum', !!s.plumExists, '~/plum'],
        ['主方案', !!s.mainSchemaExists, 'rime_ice'],
        ['Squirrel', !!s.squirrelDeployable, s.squirrelBin || '未找到可执行'],
      ];
      const rows = el('div', { class: 'card__rows' }, lights.map(([k, ok, extra]) => el('div', { class: 'row row--between' }, [
        el('span', {}, [ui.statusLight(ok ? 'ok' : 'warn'), ' ', k]),
        el('span', { class: 'muted mono nowrap', text: extra }),
      ])));
      const src = s.skinSource ? ui.badge('皮肤来源 ' + (SOURCE_LABEL[s.skinSource] || s.skinSource), 'muted') : null;
      const allOk = s.dirExists && s.plumExists && s.mainSchemaExists;
      const curSchema = (S.appearance && S.appearance.currentSchema) || null;
      return ui.card('🀄 状态', el('div', {}, [
        rows,
        el('div', { class: 'muted section', text: `当前：方案 ${curSchema || '—'} · 皮肤 ${s.currentSkin || '—'} · 布局 ${s.currentLayout || '—'} / ${s.currentOrientation || '—'}` }),
        el('div', { class: 'muted', text: '输入方案（全拼 / 各类双拼）的日常切换直接在输入法里按 F4（或 Ctrl+`）打开方案选单即可，Rime 会记住你的选择。' }),
        gated() ? el('div', { class: 'warn-box section', text: '未检测到主方案，语法模型相关操作已置灰——请先执行「安装 / 更新词库」。' }) : null,
      ]), { light: allOk ? 'ok' : 'warn', extra: src });
    }

    function vocabCard() {
      const installed = !!(S.status && S.status.mainSchemaExists);
      const checkBtn = el('button', {
        class: 'btn', type: 'button',
        text: S.checkingUpstream ? '⏳ 检查中…' : '⟳ 检查词库更新',
        disabled: S.checkingUpstream,
        on: { click: checkUpstream },
      });
      return ui.card('📚 词库', el('div', {}, [
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn--primary', type: 'button', text: '安装 / 更新词库', on: { click: () => ctx.runTask('rime', 'install_or_update', {}) } }),
          checkBtn,
          el('span', { class: 'muted', text: installed
            ? '已检测到本地安装：点击将更新词库并重新部署（官方同一条命令）。'
            : '未检测到本地安装：点击将按默认配置完整安装雾凇拼音。' }),
        ]),
        S.upstream ? upstreamLine() : null,
      ]));
    }

    /** 检查上游词库是否有新版本（对比本地与 GitHub main 的 dict version）。 */
    async function checkUpstream() {
      S.checkingUpstream = true;
      render();
      try {
        S.upstream = await api('GET', '/api/rime/upstream');
      } catch (err) {
        ui.toast('warn', `检查词库更新失败：${err.message || err}`);
      }
      S.checkingUpstream = false;
      render();
    }

    /** 上游词库更新检测结果展示行（按词库文件同步时间 vs 上游 cn_dicts 最近提交对比）。 */
    function upstreamLine() {
      const u = S.upstream;
      if (u.remoteError && !u.upstreamLatest) {
        return el('div', { class: 'warn-box section', text: `上游检查失败：${u.remoteError}（可稍后重试）` });
      }
      const day = (ms) => (ms ? new Date(ms).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '未知');
      const upDay = u.upstreamLatest ? day(Date.parse(u.upstreamLatest.date)) : '未知';
      if (u.upToDate === true) {
        return el('div', { class: 'muted section', text: `✓ 词库已是最新：本地同步于 ${day(u.localSyncedAt)}，晚于上游最近一次词库更新（${upDay}）。` });
      }
      if (u.upToDate === false) {
        return el('div', { class: 'warn-box section', text: `⬆ 上游词库有新更新：${upDay}「${u.upstreamLatest.title}」，你的词库同步于 ${day(u.localSyncedAt)}——点「安装 / 更新词库」即可更新。` });
      }
      return el('div', { class: 'muted section', text: `本地词库同步于 ${day(u.localSyncedAt)} · 上游词库最近更新 ${upDay}` });
    }

    function grammarCard() {
      const models = (S.appearance && S.appearance.grammarModels) || [];
      const applied = (S.appearance && S.appearance.grammarApplied) || [];
      const wanxiang = models.find((m) => m.name === 'wanxiang-lts-zh-hans.gram');
      const modelBtn = el('button', {
        class: 'btn btn--primary', type: 'button',
        text: wanxiang ? '⟳ 更新万象模型' : '⬇ 安装万象模型',
        on: { click: () => ctx.runTask('rime', 'install_grammar', {}) },
      });
      const modelLine = wanxiang
        ? el('span', { class: 'muted', text: `已安装 ${wanxiang.name}（${fmtSize(wanxiang.size)}）——点击将重新下载最新版覆盖（约 400MB，代理优先）。` })
        : el('span', { class: 'muted', text: '未安装。模型是独立共享文件，下载一次即可供所有方案启用。' });

      const sel = el('select', { style: 'max-width:220px', on: { change: (e) => { S.grammarScheme = e.target.value; render(); } } },
        ((S.appearance && S.appearance.schemes) || []).map((sc) => el('option', { value: sc.id, text: sc.name, selected: S.grammarScheme === sc.id })));
      const has = applied.includes(S.grammarScheme);
      const applyBtn = el('button', {
        class: 'btn', type: 'button', text: '应用到所选方案', disabled: !wanxiang,
        title: wanxiang ? '' : '请先安装万象模型',
        on: { click: () => applyGrammar() },
      });
      const removeBtn = el('button', {
        class: 'btn', type: 'button', text: '从所选方案移除', disabled: !wanxiang || !has,
        title: !wanxiang ? '请先安装万象模型' : (has ? '' : '该方案未启用语法模型'),
        on: { click: () => removeGrammar() },
      });

      return ui.card('🧠 语法模型（万象）', el('div', {}, [
        el('div', { class: 'row' }, [modelBtn, modelLine]),
        el('div', { class: 'row section' }, [
          el('span', { class: 'muted', text: '应用到方案' }), sel, applyBtn, removeBtn,
        ]),
        applied.length
          ? el('div', { class: 'muted section', text: '已启用万象的方案：' + applied.map((id) => {
              const sc = ((S.appearance && S.appearance.schemes) || []).find((x) => x.id === id);
              return sc ? sc.name : id;
            }).join(' · ') })
          : el('div', { class: 'muted section', text: '尚未有任何方案启用万象。' }),
        el('div', { class: 'muted', text: '机制说明：模型文件与方案配置相互独立——安装（下载 .gram）一次全方案共享；应用/移除 = 给所选方案写/删语法补丁并重新部署。未启用模型的方案照常打字，只是少了整句语法增强。' }),
      ]));
    }

    /** 应用万象到所选方案（二次确认）。 */
    async function applyGrammar() {
      const name = (((S.appearance && S.appearance.schemes) || []).find((x) => x.id === S.grammarScheme) || {}).name || S.grammarScheme;
      const ok = await ui.confirmDialog({
        title: '应用万象语法模型', confirmLabel: '确认应用',
        body: el('div', {}, [
          el('p', { class: 'muted', text: `将为「${name}」启用万象语法模型：写入 ${S.grammarScheme}.custom.yaml 并重新部署。` }),
          el('p', { class: 'muted section', text: '已有配置会先原地备份（保留最近 5 份）并同步集中备份。' }),
        ]),
      });
      if (!ok) return;
      await ctx.runTask('rime', 'apply_grammar', { schema: S.grammarScheme }, { confirm: true });
    }

    /** 从所选方案移除万象（二次确认）。 */
    async function removeGrammar() {
      const name = (((S.appearance && S.appearance.schemes) || []).find((x) => x.id === S.grammarScheme) || {}).name || S.grammarScheme;
      const ok = await ui.confirmDialog({
        title: '移除万象语法模型', confirmLabel: '确认移除', danger: true,
        body: el('div', {}, [
          el('p', { class: 'muted', text: `将从「${name}」移除万象语法模型：删除 ${S.grammarScheme}.custom.yaml 并重新部署。` }),
          el('p', { class: 'muted section', text: '模型文件本身不会被删除，其他方案不受影响；删前自动备份。' }),
        ]),
      });
      if (!ok) return;
      await ctx.runTask('rime', 'remove_grammar', { schema: S.grammarScheme }, { confirm: true });
    }

    /** 字节数 → 人类可读（MB/GB，一位小数）。 */
    function fmtSize(n) {
      if (!Number.isFinite(n) || n <= 0) return '—';
      if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
      return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
    }

    // ============================ 皮肤网格（22 款） ============================
    function skinGrid() {
      const grid = el('div', { class: 'grid grid--4' });
      for (const sk of (S.skins && S.skins.schemes) || []) grid.append(skinCard(sk));
      return ui.card('🎨 外观 · 皮肤（22 款，色块预览）', el('div', {}, [
        el('div', { class: 'muted', text: '色块按后端归一化的 {hex, alpha} 以 rgba() 合成（叠在中性底上）：候选窗底色 / 文字色 / 高亮背景 / 高亮文字 / 注释色。' }),
        grid,
      ]));
    }

    function skinCard(sk) {
      const active = S.skin === sk.id;
      const btn = el('button', {
        class: 'card', type: 'button',
        style: 'text-align:left; width:100%; cursor:pointer;' + (active ? ' border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent);' : ''),
        on: { click: () => { S.skin = sk.id; render(); } },
      }, [
        candidatePreview(sk.colors),
        el('div', { class: 'row row--between', style: 'margin-top:6px' }, [
          el('span', { class: 'nowrap', text: sk.name }),
          active ? ui.badge('当前使用', 'ok') : null,
        ]),
      ]);
      if (!sk.hasColors) btn.append(el('div', { class: 'muted', style: 'font-size:11px', text: '该方案未定义此颜色（中性色兜底）' }));
      return btn;
    }

    /** 候选窗示意：用 5 个色值渲染（back/text/hilitedBack/hilitedText/comment）。 */
    function candidatePreview(colors) {
      const back = cssColor(colors && colors.back);
      const text = cssColor(colors && colors.text);
      const hBack = cssColor(colors && colors.hilitedBack);
      const hText = cssColor(colors && colors.hilitedText);
      const comment = cssColor(colors && colors.comment);
      const win = el('div', { style: `background:${back || 'rgba(140,140,140,0.18)'}; border:1px solid rgba(0,0,0,0.08); border-radius:6px; padding:6px 8px;` }, [
        el('div', { style: `color:${text || 'inherit'}; font-size:12px; line-height:1.5;`, text: 'ni hao' }),
        el('div', { style: 'margin-top:2px;' }, [
          el('span', { style: `background:${hBack || 'rgba(140,140,140,0.30)'}; color:${hText || 'inherit'}; font-size:12px; border-radius:4px; padding:0 4px;`, text: '你好' }),
          el('span', { style: `color:${comment || 'inherit'}; font-size:12px; margin-left:6px;`, text: 'note' }),
        ]),
      ]);
      return el('div', { style: 'background:#ffffff; border-radius:8px; padding:4px;' }, [win]);
    }

    // ============================ 布局 + 应用外观 ============================
    function appearanceCard() {
      const grid = el('div', { class: 'grid grid--4' });
      for (const l of (S.appearance && S.appearance.layouts) || []) {
        const active = S.layoutIdx === l.index;
        grid.append(el('button', {
          class: 'card', type: 'button',
          style: 'text-align:left; cursor:pointer;' + (active ? ' border-color:var(--accent);' : ''),
          on: { click: () => { S.layoutIdx = l.index; render(); } },
        }, [
          el('div', { class: 'muted', text: layoutGlyph(l) }),
          el('div', { text: l.label }),
          active ? ui.badge('当前', 'ok') : null,
        ]));
      }
      return ui.card('🖌 外观 · 布局（4 种）', el('div', {}, [
        el('div', { class: 'muted', text: '布局映射：1→竖向/水平、2→横向/水平、3→竖向/垂直、4→横向/垂直（与后端完全一致）。' }),
        grid,
        el('div', { class: 'row section' }, [
          el('button', { class: 'btn btn--primary', type: 'button', text: '应用外观（预览 diff）', on: { click: applyAppearance } }),
          el('span', { class: 'muted', text: `将写入：皮肤 ${S.skin || '—'} · 布局 ${S.layoutIdx || '—'}` }),
        ]),
      ]));
    }

    async function applyAppearance() {
      const layoutDef = ((S.appearance && S.appearance.layouts) || []).find((l) => l.index === S.layoutIdx) || null;
      const skin = S.skin || '';
      if (!skin && !layoutDef) { ui.toast('warn', '未选择皮肤或布局'); return; }
      const ok = await ui.confirmDialog({
        title: '确认写入 squirrel.custom.yaml', confirmLabel: '确认写入',
        body: el('div', {}, [
          el('p', { class: 'muted', text: '写入前将原地备份（保留最近 5 份）并同步一份到集中备份目录。' }),
          el('div', { class: 'muted section', text: '将写入的 patch（依据 patch_yaml 语义生成）：' }),
          ui.diffView(buildPreview(skin, layoutDef)),
        ]),
      });
      if (ok) await ctx.runTask('rime', 'apply_appearance', { skin, layout: S.layoutIdx }, { confirm: true });
    }

    /** 由「确定性 patch 语义 + 当前值」构造 diff 预览（§3.12 无独立 preview 端点）。 */
    function buildPreview(skin, layoutDef) {
      const cur = (S.appearance && S.appearance.current) || {};
      const lines = [{ type: 'same', text: 'patch:' }];
      const pair = (key, oldV, newV) => {
        if (newV == null || newV === '') return;
        if (oldV === newV) { lines.push({ type: 'same', text: `    "${key}": ${newV}` }); return; }
        if (oldV) lines.push({ type: 'del', text: `    "${key}": ${oldV}` });
        lines.push({ type: 'add', text: `    "${key}": ${newV}` });
      };
      if (skin) { pair('style/color_scheme', cur.skin, skin); pair('style/color_scheme_dark', cur.skin, skin); }
      if (layoutDef) { pair('style/candidate_list_layout', cur.layout, layoutDef.layout); pair('style/text_orientation', cur.orientation, layoutDef.orientation); }
      return lines;
    }

    // ============================ 工具 ============================
    /** {hex,alpha} → rgba()（前端只做合成，不解析 AARRGGBB；§8.1）。 */
    function cssColor(c) {
      if (!c || typeof c.hex !== 'string' || !c.valid) return null;
      const h = c.hex.replace('#', '');
      const r = parseInt(h.slice(0, 2), 16); const g = parseInt(h.slice(2, 4), 16); const b = parseInt(h.slice(4, 6), 16);
      const a = typeof c.alpha === 'number' ? c.alpha : 1;
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    function layoutIndexOf(layouts, layout, orientation) {
      const hit = (layouts || []).find((l) => l.layout === layout && l.orientation === orientation);
      return hit ? hit.index : 1; // 未知 → 默认 1（竖向/水平）
    }
    const layoutGlyph = (l) => (l.layout === 'stacked' ? '▭' : '▬') + (l.orientation === 'vertical' ? ' ⇅ 竖排' : ' ⇆ 横排');

    ctx.on('done', (t) => { if (t && t.module === 'rime') load(); });

    load();
  },

  unmount() { /* 订阅由 app.js 统一回收 */ },
};
