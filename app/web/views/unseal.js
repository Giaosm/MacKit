/**
 * MacKit · 应用解隔离（视图）
 *
 * 语义移植自原 `shell/unseal.sh`（参考脚本已于 2026-09-16 从仓库移除）。
 *
 * 契约：
 *   - GET /api/unseal/precheck?paths=a|b|c → { items:[{input,path,exists,isDir,hasQuarantine,
 *                                              needsAdmin,note?,discovered?}] }（多路径用 | 连接并 encodeURIComponent）
 *   - unseal.unseal_paths{ paths } → 逐项 xattr -dr；普通权限失败才降级 osascript 授权框
 *   - 结果三分类：ok / skip（授权被取消 = AUTH_CANCELLED，**黄色**，不是失败）/ fail（可复制路径）
 *
 * 三种输入：拖拽 / 手工粘贴（多行）。浏览器安全限制：拿不到绝对路径时明确降级提示，绝不伪造路径。
 */

export default {
  id: 'unseal',
  title: '应用解隔离',

  mount(root, ctx) {
    const { el, ui, api } = ctx;
    const S = { paths: [], items: null, selected: new Set(), logPaths: [] };
    let updateStart = () => {};

    // ============================ 头部 ============================
    root.append(el('div', { class: 'view-head' }, [
      el('div', {}, [el('h1', { text: '应用解隔离' }), el('div', { class: 'muted', text: '移除 com.apple.quarantine（拖拽 / 粘贴 · 预检 · 批量）' })]),
      el('button', { class: 'btn btn--ghost', type: 'button', text: '清空', on: { click: () => { S.paths = []; S.items = null; S.selected = new Set(); render(); } } }),
    ]));

    // ============================ 拖拽区 ============================
    const dz = el('div', {
      class: 'dropzone',
      on: {
        dragover: (e) => { e.preventDefault(); dz.classList.add('is-over'); },
        dragleave: () => dz.classList.remove('is-over'),
        drop: (e) => { e.preventDefault(); dz.classList.remove('is-over'); onDrop(e); },
      },
    }, [
      el('div', { text: '把 .app 或文件夹拖到这里（支持多选；文件夹会自动递归发现 .app）' }),
      el('div', { class: 'muted', style: 'margin-top:8px; font-size:12px', text: '浏览器出于安全限制通常无法读取拖入项的绝对路径；若无法获取，请改用手工粘贴。' }),
    ]);

    // ============================ 手工粘贴 ============================
    const pasteBox = el('textarea', { rows: '4', placeholder: '每行一个路径，例如：\n/Applications/Some.app\n~/Downloads/Bundle/', style: 'width:100%; font-family:var(--font-mono); font-size:12px' });
    const addBtn = el('button', { class: 'btn btn--primary', type: 'button', text: '添加到待处理', on: { click: () => { addPaths(pasteBox.value.split(/\r?\n/)); pasteBox.value = ''; } } });

    // ============================ 动态容器 ============================
    const pendingBox = el('div');
    const resultBox = el('div');
    root.append(dz, ui.card('手工粘贴路径', el('div', {}, [pasteBox, el('div', { class: 'row section' }, [addBtn, el('span', { class: 'muted', text: '路径会被规范化（剥离引号 / 去空白 / 展开 ~）；空路径与不存在项在预检阶段即给出明确提示。' })])])), pendingBox, resultBox);

    // ============================ 逻辑 ============================
    function onDrop(e) {
      const dt = e.dataTransfer;
      const files = dt && dt.files ? Array.from(dt.files) : [];
      const got = [];
      let blocked = false;
      for (const f of files) { if (typeof f.path === 'string' && f.path) got.push(f.path); else blocked = true; }
      if (!got.length) { ui.toast('warn', '浏览器无法获取拖入项的绝对路径，请改用手工粘贴路径'); return; }
      if (blocked) ui.toast('warn', '部分项未能获取绝对路径，已忽略（可手工粘贴补齐）');
      addPaths(got);
      ui.toast('ok', `已添加 ${got.length} 个路径`);
    }

    function addPaths(raws) {
      const cleaned = (raws || []).map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
      if (!cleaned.length) { ui.toast('warn', '未解析到任何有效路径（空行已忽略）'); return; }
      for (const p of cleaned) if (!S.paths.includes(p)) S.paths.push(p);
      runPrecheck();
    }

    let precheckSeq = 0; // 竞态保护：连续添加 / 移除时只采用最后一次预检结果
    async function runPrecheck() {
      if (!S.paths.length) { S.items = []; render(); return; }
      const my = ++precheckSeq;
      pendingBox.innerHTML = '';
      pendingBox.append(el('div', { class: 'view-loading', text: '正在预检…' }));
      let items;
      try { items = (await api('GET', `/api/unseal/precheck?paths=${encodeURIComponent(S.paths.join('|'))}`)).items || []; }
      catch (err) {
        if (my !== precheckSeq) return;
        pendingBox.innerHTML = '';
        pendingBox.append(el('div', { class: 'err-box', text: `预检失败：${err.message || err}` }));
        return;
      }
      if (my !== precheckSeq) return;
      S.items = items;
      S.selected = new Set(S.items.filter((it) => it.exists && it.hasQuarantine !== false).map((it) => it.path));
      render();
    }

    function render() { renderPending(); renderResult(); }

    function renderPending() {
      pendingBox.innerHTML = '';
      const items = S.items || [];
      if (!items.length) {
        pendingBox.append(ui.card('待处理', ui.empty({ icon: '📥', title: '尚未添加任何路径', text: '拖入 .app / 文件夹，或在上方手工粘贴路径后点击「添加到待处理」。' })));
        return;
      }
      const list = el('ul', { class: 'filelist' }, items.map((it) => {
        const actionable = it.exists && it.hasQuarantine !== false;
        const cb = el('input', {
          type: 'checkbox', checked: S.selected.has(it.path), disabled: !it.exists,
          on: { change: (e) => { if (e.target.checked) S.selected.add(it.path); else S.selected.delete(it.path); updateStart(); } },
        });
        const qLabel = !it.exists ? '路径不存在' : it.hasQuarantine === null ? '隔离：未知' : it.hasQuarantine ? '有隔离' : '无隔离';
        return el('li', { style: actionable ? '' : 'opacity:.7' }, [
          el('div', { class: 'row row--between' }, [
            el('label', { class: 'check', style: 'flex:1' }, [cb, el('span', { class: 'mono', text: it.path || it.input || '(空)' })]),
            el('span', { class: 'row' }, [
              ui.badge(qLabel, !it.exists ? 'err' : it.hasQuarantine ? 'warn' : 'muted'),
              el('button', { class: 'btn btn--sm', type: 'button', text: '移除', on: { click: () => { S.paths = S.paths.filter((x) => x !== (it.input || it.path)); S.selected.delete(it.path); runPrecheck(); } } }),
            ]),
          ]),
          el('div', { class: 'muted', style: 'font-size:12px' }, [
            `存在：${it.exists ? '是' : '否'} · 目录：${it.isDir ? '是' : '否'} · 需管理员：${it.needsAdmin ? '是' : '否'}`,
            it.discovered && it.discovered.length ? ` · 递归发现 ${it.discovered.length} 个 .app` : '',
            it.note ? ` · ${it.note}` : '',
          ]),
          it.discovered && it.discovered.length ? el('ul', { class: 'filelist', style: 'margin-top:4px' }, it.discovered.map((p) => el('li', { class: 'mono muted', text: p }))) : null,
        ]);
      }));
      const startBtn = el('button', { class: 'btn btn--primary', type: 'button', text: '开始解隔离', on: { click: start } });
      updateStart = () => { const n = S.selected.size; startBtn.textContent = `开始解隔离（${n}）`; startBtn.disabled = n === 0; };
      updateStart();
      const noQuarantine = items.filter((it) => it.exists && it.hasQuarantine === false).length;
      const missing = items.filter((it) => !it.exists).length;
      pendingBox.append(ui.card(`待处理（${items.length}）`, el('div', {}, [
        list,
        el('div', { class: 'row section' }, [startBtn, el('span', { class: 'muted', text: `已自动勾选可处理项；无隔离属性 ${noQuarantine} 个（不进入执行队列）、路径不存在 ${missing} 个会被跳过。` })]),
      ])));
    }

    async function start() {
      const paths = Array.from(S.selected);
      if (!paths.length) { ui.toast('warn', '请先勾选要处理的目标'); return; }
      const ok = await ui.confirmDialog({
        title: `确认解除隔离（${paths.length} 个）`, confirmLabel: '开始',
        body: el('div', {}, [
          el('p', { text: '将对以下目标递归移除 com.apple.quarantine 隔离属性：' }),
          el('ul', {}, paths.map((p) => el('li', { class: 'mono', text: p }))),
          el('p', { class: 'muted', text: '个别项必要时会弹出系统管理员授权框；取消授权将被记为「已跳过」，不影响其余项。' }),
        ]),
      });
      if (!ok) return;
      S.logPaths = [];
      try { await ctx.runTask('unseal', 'unseal_paths', { paths }); } catch { /* runTask 内部已 toast */ }
      renderResult();
    }

    function renderResult() {
      resultBox.innerHTML = '';
      const t = ctx.state.task;
      if (!t || t.module !== 'unseal') return;
      const steps = t.steps || [];
      const pathOf = resolvePaths(steps);
      const by = (st) => steps.filter((s) => s.status === st);
      const skipped = by('skip').concat(by('cancelled'));
      const authCancelled = skipped.filter((s) => s.error && s.error.code === 'AUTH_CANCELLED');
      const otherSkip = skipped.filter((s) => !(s.error && s.error.code === 'AUTH_CANCELLED'));
      const failed = by('fail');
      const okList = by('ok');
      const names = (arr) => el('ul', {}, arr.map((s) => el('li', { class: 'mono', text: pathOf.get(s.id) || s.title })));
      resultBox.append(ui.card('结果', el('div', {}, [
        el('div', { class: 'row section' }, [
          ui.badge(`✅ 成功 ${okList.length}`, 'ok'),
          ui.badge(`⏭ 跳过 ${skipped.length}`, 'warn'),
          ui.badge(`❌ 失败 ${failed.length}`, 'err'),
        ]),
        okList.length ? el('div', {}, [el('div', { class: 'muted', text: '✅ 成功：' }), names(okList)]) : null,
        authCancelled.length ? el('div', { class: 'warn-box section' }, [`⏭ 已跳过（授权被取消）：${authCancelled.map((s) => pathOf.get(s.id) || s.title).join('、')}`]) : null,
        otherSkip.length ? el('div', { class: 'section' }, [el('div', { class: 'muted', text: '⏭ 其他跳过：' }), names(otherSkip)]) : null,
        failed.length ? el('div', { class: 'err-box section' }, [
          el('div', { text: '❌ 失败（可复制路径后重试）：' }),
          el('ul', {}, failed.map((s) => el('li', {}, [
            el('span', { class: 'mono', text: pathOf.get(s.id) || s.title }), ' ',
            el('button', { class: 'btn btn--sm', type: 'button', text: '复制路径', on: { click: () => ui.copy(pathOf.get(s.id) || s.title, '已复制路径') } }),
          ]))),
        ]) : null,
      ])));
    }

    /** 把 step 映射到完整路径：unseal 步骤按顺序取捕获的「正在处理:」日志；缺失项直接用标题里的全路径。 */
    function resolvePaths(steps) {
      const map = new Map(); let k = 0;
      for (const s of steps) {
        const ttl = String(s.title || '');
        if (ttl.startsWith('路径不存在')) map.set(s.id, ttl.replace(/^路径不存在\s*/, ''));
        else map.set(s.id, S.logPaths[k++] || ttl.replace(/^解隔离\s*/, ''));
      }
      return map;
    }

    // 捕获逐项完整路径（用于失败项复制）
    ctx.on('log', (line) => { const m = /^正在处理:\s*(.+)$/.exec((line && line.text) || ''); if (m) S.logPaths.push(m[1].trim()); });
    ctx.on('task', (t) => { if (t && t.module === 'unseal') renderResult(); });
    ctx.on('done', (t) => { if (t && t.module === 'unseal') renderResult(); });

    render();
  },

  unmount() { /* 订阅由 app.js 统一回收 */ },
};
