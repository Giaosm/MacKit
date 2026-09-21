/**
 * MacKit · 应用解隔离（视图）
 *
 * 语义移植自原 `shell/unseal.sh`（参考脚本已于 2026-09-16 从仓库移除）。
 *
 * 契约：
 *   - GET /api/unseal/precheck?paths=a|b|c → { items:[{input,path,exists,isDir,hasQuarantine,
 *                                              needsAdmin,note?,discovered?}] }（多路径用 | 连接并 encodeURIComponent）
 *   - GET /api/unseal/scan → { items:[{name,path,reason,icon}], total, quarantined, blocked, unevaluated }
 *     （unevaluated = 隔离了但 spctl 评估失败、无法判定的项数，如实显示不猜结论）
 *   - unseal.unseal_paths{ paths } → 逐项 xattr -dr；普通权限失败才降级 osascript 授权框
 *   - 结果三分类：ok / skip（授权被取消 = AUTH_CANCELLED，**黄色**，不是失败）/ fail（可复制路径）
 *
 * 单卡片布局：顶部工具条（一键扫描 + 手工粘贴），下方依次为「扫描结果（图标网格）」、
 * 「手工粘贴（列表）」、「结果」。浏览器安全限制：拿不到绝对路径时明确降级提示，绝不伪造路径。
 * 拖拽能力已移除（浏览器无法可靠读取拖入项绝对路径，实用性为零）。
 * 结果卡的「完整路径」直接读 step.path（后端随 step 下发）；不再依赖日志行的位置重建。
 */

export default {
  id: 'unseal',
  title: '应用解隔离',

  mount(root, ctx) {
    const { el, ui, api } = ctx;
    const S = { paths: [], items: null, selected: new Set(), scan: null, scanning: false, scanSelected: new Set(), scanUnsealing: false };
    let updateStart = () => {};
    let updateScanBtn = () => {};

    // ============================ 头部 ============================
    root.append(el('div', { class: 'view-head' }, [
      el('div', {}, [el('h1', { text: '应用解隔离' }), el('div', { class: 'muted', text: '检查 /Applications 中被隔离且打不开的应用，或手工粘贴任意路径，批量移除 com.apple.quarantine。' })]),
      el('button', { class: 'btn btn--ghost', type: 'button', text: '清空', on: { click: () => { S.paths = []; S.items = null; S.selected = new Set(); S.scan = null; render(); } } }),
    ]));

    // ============================ 单一内容卡片 ============================
    const scanBtn = el('button', { class: 'btn btn--primary', type: 'button', text: '检查 /Applications', on: { click: () => runScan() } });
    const scanUnsealBtn = el('button', { class: 'btn', type: 'button', text: '解隔离选中', on: { click: () => unsealPaths(Array.from(S.scanSelected), true) } });
    const pasteBox = el('textarea', { rows: '2', placeholder: '或手工粘贴路径（每行一个，如 /Applications/Some.app 或 ~/Downloads/Bundle）', style: 'width:100%; font-family:var(--font-mono); font-size:12px; resize:vertical' });
    const addBtn = el('button', { class: 'btn', type: 'button', text: '添加', on: { click: () => { addPaths(pasteBox.value.split(/\r?\n/)); pasteBox.value = ''; } } });

    const scanArea = el('div');
    const pendingBox = el('div');
    const resultBox = el('div');

    // 「解隔离选中」计数 + 扫描忙碌态。
    // ★ 2026-09-21 修：updateScanBtn 此前只声明 `let updateScanBtn = () => {}` 却从未赋值 ——
    //   死代码，导致按钮既没有已选数量、也不会在扫描中禁用（可以连点出多轮 spctl 风暴）。
    updateScanBtn = () => {
      const n = S.scanSelected.size;
      scanUnsealBtn.textContent = `解隔离选中（${n}）`;
      scanUnsealBtn.disabled = n === 0;
      scanBtn.disabled = S.scanning;
      scanBtn.textContent = S.scanning ? '扫描中…' : '检查 /Applications';
    };
    updateScanBtn();

    root.append(ui.card('解隔离', el('div', {}, [
      el('div', { class: 'toolbar' }, [scanBtn, el('div', { class: 'grow' }, [pasteBox]), addBtn]),
      scanArea,
      pendingBox,
      resultBox,
    ])));

    // ============================ 逻辑 ============================
    async function runScan() {
      if (S.scanning) return; // 双保险：后端也有 in-flight 去重，且按钮会同时被禁用
      S.scanning = true; S.scan = null; updateScanBtn(); renderScan();
      try {
        const data = await api('GET', '/api/unseal/scan');
        S.scan = data || { items: [] };
        S.scanSelected = new Set((S.scan.items || []).map((it) => it.path));
      } catch (err) {
        S.scan = { error: (err && err.message) || String(err) };
      } finally {
        S.scanning = false; updateScanBtn(); renderScan();
      }
    }

    function renderScan() {
      scanArea.innerHTML = '';
      if (S.scanning) { scanArea.append(el('div', { class: 'view-loading', text: '正在扫描应用并评估 Gatekeeper（首次可能要十几秒）…' })); return; }
      const s = S.scan;
      if (!s) return;
      if (s.error) { scanArea.append(el('div', { class: 'err-box', text: `扫描失败：${s.error}` })); return; }
      const items = s.items || [];
      const head = el('div', { class: 'row row--between section' }, [
        el('span', { class: 'unseal-sub', text: '扫描结果' }),
        el('span', { class: 'row' }, [
          ui.badge(`应用总数 ${s.total}`, 'muted'),
          ui.badge(`隔离 ${s.quarantined}`, 'warn'),
          ui.badge(`无法打开 ${s.blocked}`, s.blocked > 0 ? 'err' : 'ok'),
          // 隔离了但 spctl 评估失败（超时等）→ 如实显示，不猜"能打开"也不猜"打不开"
          s.unevaluated > 0 ? ui.badge(`未评估 ${s.unevaluated}`, 'muted') : null,
        ]),
      ]);
      let body;
      if (items.length === 0) {
        body = ui.empty({ icon: '✅', title: '没有无法打开的应用', text: '当前 /Applications 里被隔离的应用都能正常通过 Gatekeeper 打开。' });
      } else {
        const grid = el('div', { class: 'app-grid' }, items.map((it) => {
          const checked = S.scanSelected.has(it.path);
          const avatar = it.icon
            ? el('img', { src: it.icon, alt: it.name, class: 'app-icon', width: 48, height: 48 })
            : el('div', { class: 'app-icon app-icon--fallback', text: (it.name[0] || '?').toUpperCase() });
          return el('label', { class: 'app-card' }, [
            avatar,
            el('div', { class: 'app-card__body' }, [
              el('div', { class: 'app-card__name', text: it.name }),
              el('div', { class: 'app-card__reason', text: it.reason || '' }),
            ]),
            el('input', {
              type: 'checkbox', checked,
              on: { change: (e) => { if (e.target.checked) S.scanSelected.add(it.path); else S.scanSelected.delete(it.path); updateScanBtn(); } },
            }),
          ]);
        }));
        body = el('div', {}, [
          grid,
          el('div', { class: 'row section' }, [scanUnsealBtn, el('span', { class: 'muted', text: '勾选需要解隔离的应用（默认全选），移除其 com.apple.quarantine 后即可正常打开。' })]),
        ]);
      }
      scanArea.append(head, body);
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
      if (!items.length) return;
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
      const startBtn = el('button', { class: 'btn btn--primary', type: 'button', text: '开始解隔离', on: { click: () => unsealPaths(Array.from(S.selected), false) } });
      updateStart = () => { const n = S.selected.size; startBtn.textContent = `开始解隔离（${n}）`; startBtn.disabled = n === 0; };
      updateStart();
      const noQuarantine = items.filter((it) => it.exists && it.hasQuarantine === false).length;
      const missing = items.filter((it) => !it.exists).length;
      pendingBox.append(
        el('div', { class: 'row row--between section' }, [el('span', { class: 'unseal-sub', text: `手工粘贴（${items.length}）` }), startBtn]),
        list,
        el('div', { class: 'muted', style: 'font-size:12px' }, `已自动勾选可处理项；无隔离属性 ${noQuarantine} 个（不进入执行队列）、路径不存在 ${missing} 个会被跳过。`),
      );
    }

    async function unsealPaths(pathsToUnseal, fromScan) {
      if (!pathsToUnseal.length) { ui.toast('warn', '请先选择要处理的目标'); return; }
      const ok = await ui.confirmDialog({
        title: `确认解除隔离（${pathsToUnseal.length} 个）`, confirmLabel: '开始',
        body: el('div', {}, [
          el('p', { text: '将对以下目标递归移除 com.apple.quarantine 隔离属性：' }),
          el('ul', {}, pathsToUnseal.map((p) => el('li', { class: 'mono', text: p }))),
          el('p', { class: 'muted', text: '个别项必要时会弹出系统管理员授权框；取消授权将被记为「已跳过」，不影响其余项。' }),
        ]),
      });
      if (!ok) return;
      if (fromScan) S.scanUnsealing = true;
      try { await ctx.runTask('unseal', 'unseal_paths', { paths: pathsToUnseal }); }
      catch { /* runTask 内部已 toast */ }
      // 结果卡只由 done 订阅（下方 ctx.on('done')）重建一次；此处不再重复 renderResult()。
    }

    function renderResult() {
      resultBox.innerHTML = '';
      const t = ctx.state.task;
      if (!t || t.module !== 'unseal') return;
      const steps = t.steps || [];
      const by = (st) => steps.filter((s) => s.status === st);
      const of = (s) => stepPath(s);
      const skipped = by('skip').concat(by('cancelled'));
      const authCancelled = skipped.filter((s) => s.error && s.error.code === 'AUTH_CANCELLED');
      const otherSkip = skipped.filter((s) => !(s.error && s.error.code === 'AUTH_CANCELLED'));
      const failed = by('fail');
      const okList = by('ok');
      const names = (arr) => el('ul', {}, arr.map((s) => el('li', { class: 'mono', text: of(s) })));
      resultBox.append(
        el('div', { class: 'row row--between section' }, [
          el('span', { class: 'unseal-sub', text: '结果' }),
          el('span', { class: 'row' }, [
            ui.badge(`✅ 成功 ${okList.length}`, 'ok'),
            ui.badge(`⏭ 跳过 ${skipped.length}`, 'warn'),
            ui.badge(`❌ 失败 ${failed.length}`, 'err'),
          ]),
        ]),
        okList.length ? el('div', {}, [el('div', { class: 'muted', text: '✅ 成功：' }), names(okList)]) : null,
        authCancelled.length ? el('div', { class: 'warn-box section' }, [`⏭ 已跳过（授权被取消）：${authCancelled.map((s) => of(s)).join('、')}`]) : null,
        otherSkip.length ? el('div', { class: 'section' }, [el('div', { class: 'muted', text: '⏭ 其他跳过：' }), names(otherSkip)]) : null,
        failed.length ? el('div', { class: 'err-box section' }, [
          el('div', { text: '❌ 失败（可复制路径后重试）：' }),
          el('ul', {}, failed.map((s) => el('li', {}, [
            el('span', { class: 'mono', text: of(s) }), ' ',
            el('button', { class: 'btn btn--sm', type: 'button', text: '复制路径', on: { click: () => ui.copy(of(s), '已复制路径') } }),
          ]))),
        ]) : null,
      );
    }

    /**
     * step → 完整路径：后端把完整路径随 step 下发（`step.path`，runner 会展开自定义字段）。
     * ★ 2026-09-21 修：此前是「按顺序取捕获到的『正在处理:』日志行」（`S.logPaths[k++]`），
     *   只要丢一行日志 / 切视图重挂载 / 刷新页面，整列路径就会错位，结果卡显示别人的路径。
     *   旧历史任务没有 `path` 字段 → 回退到标题（basename 或「路径不存在 <全路径>」）。
     */
    function stepPath(s) {
      if (s && typeof s.path === 'string' && s.path) return s.path;
      const ttl = String((s && s.title) || '');
      if (ttl.startsWith('路径不存在')) return ttl.replace(/^路径不存在\s*/, '');
      return ttl.replace(/^解隔离\s*/, '');
    }

    // 终态结果卡只由 done 重建一次；扫描解隔离完成后顺手刷新一次扫描结果（让刚解隔离的项消失）
    ctx.on('done', (t) => {
      if (t && t.module === 'unseal') {
        renderResult();
        if (S.scanUnsealing) { S.scanUnsealing = false; runScan(); }
      }
    });

    render();
  },

  unmount() { /* 订阅由 app.js 统一回收 */ },
};
