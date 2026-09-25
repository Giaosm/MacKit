/**
 * MacKit · 任务调度层
 *
 *   - 按 lane 分区的串行队列（设计 §5.2）：同一 lane 内串行、不同 lane 间并行。
 *     default lane = 现有 7 个模块（行为不变）；music lane = 音乐下载/安装；music-search lane = 搜索会话。
 *     这样既保住 brew 串行（不抢 index.lock），又让音乐下载可与其它任务并行。
 *   - Step 状态机：pending → running → ok/fail/skip/cancelled
 *   - SSE 广播：单一来源在后端（内存环形缓冲 + 落盘）
 *   - 取消：AbortSignal → exec.js 侧 SIGTERM→等 3s→SIGKILL；未开始步骤置 skip；不回滚
 *   - 单步超时：默认 600s，可由 stepPlan.timeoutMs 覆盖
 *   - 日志环形缓冲 2000 行 + 落盘全量；任务完成写历史
 *
 * 本文件不 import child_process —— 子进程句柄由 exec.js 持有，runner 只通过 signal 取消。
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import * as store from './store.js';
import * as exec from './exec.js';

const RING_MAX = 2000;
const DEFAULT_STEP_TIMEOUT_MS = exec.DEFAULT_TIMEOUT_MS;
/** 内存中保留的最近任务数（内存裁剪用；对外 listTasks 上限 TASKS_LIST_KEEP，落盘历史另有 HISTORY_KEEP=10） */
const MEMORY_KEEP = 10;
/** listTasks 对外返回的最大条数（只回最新）。 */
const TASKS_LIST_KEEP = 10;

/** @type {Map<string, any>} */
const records = new Map();

// ------------------------------ lane 分区队列（设计 §5.2） ------------------------------
// 每个 lane 有各自独立的 queue / running / currentId：**同一 lane 内串行、不同 lane 间并行**。
//   · default lane = 现有 7 个模块（不传 lane 即落这里，行为 100% 不变）；
//   · music lane  = 音乐模块的下载 / 安装等写任务；
//   · music-search lane = 音乐搜索会话的子进程（独立于 music lane，取消下载时不误杀）。
// brew 抢锁安全：只有 default lane 会跑 brew，且 default lane 内部仍严格串行 ⇒ 任意时刻
// 至多 1 个 brew 进程，index.lock 不会争用；music lane 不调用 brew，两者无共享资源。
const DEFAULT_LANE = 'default';
/** @type {Map<string, {queue:string[], running:boolean, currentId:string|null}>} */
const LANES = new Map();

/** 取（必要时创建）指定 lane 的状态槽；name 缺省落 DEFAULT_LANE。 */
function lane(name) {
  const n = typeof name === 'string' && name ? name : DEFAULT_LANE;
  let l = LANES.get(n);
  if (!l) { l = { queue: [], running: false, currentId: null }; LANES.set(n, l); }
  return l;
}

// ------------------------------ 序号 #N ------------------------------
// 注意：该编号已不再作为用户可见编号（前端改为展示相对时间），仅作内部排序 / 溯源用。
let seqCounter = 1;
(function initSeq() {
  try {
    let max = 0;
    for (const h of store.listHistory()) if (typeof h.seq === 'number' && h.seq > max) max = h.seq;
    seqCounter = max + 1;
  } catch { seqCounter = 1; }
})();

function rand6() { return crypto.randomBytes(4).toString('hex').slice(0, 6); }
function newTaskId() { return `t_${Date.now()}_${rand6()}`; }

// ------------------------------ 事件广播 ------------------------------
function emit(rec, evt) {
  try { rec.emitter.emit('event', evt); } catch { /* 订阅者异常不影响任务 */ }
}
function emitTask(rec) { emit(rec, { type: 'task', taskId: rec.task.id, task: snapshotTask(rec.task) }); }

/** 追加一行日志（写内存环形缓冲 + 落盘 + 广播）。 */
function pushLog(rec, level, text) {
  const line = { seq: ++rec.seq, ts: Date.now(), level: level || 'info', text: String(text) };
  rec.logs.push(line);
  if (rec.logs.length > RING_MAX) rec.logs.splice(0, rec.logs.length - RING_MAX);
  store.appendLog(rec.task.id, line);
  emit(rec, { type: 'log', taskId: rec.task.id, line });
}

function snapshotTask(task) {
  return {
    ...task,
    // 对外投影必须先脱敏：快照会经 emit / getTask / listTasks 直达 HTTP 响应，
    // 否则内存里的 token / password / 备份信封会被原样回吐（磁盘侧已由 writeHistory 脱敏）。
    params: store.redactParams(task.params),
    steps: task.steps.map((s) => ({ ...s, error: s.error ? { ...s.error } : null })),
    progress: { ...task.progress },
    counts: { ...task.counts },
    error: task.error ? { ...task.error } : null,
  };
}

// ------------------------------ 上下文构造 ------------------------------
/** 构造 steps(params, ctx) 阶段的基础上下文。 */
function makeBaseCtx(rec) {
  // 把本任务的 lane 注入每一条 exec 出口，使 steps() 阶段发起的子进程也被正确打标
  // （设计 §5.2）。显式传入的 opts.lane 优先级更高，允许模块在特殊场景覆盖。
  const boundExec = {
    ...exec,
    run: (bin, args, opts = {}) => exec.run(bin, args, { lane: rec.lane, ...opts }),
    runWithChannel: (policy, desc, bin, args, opts = {}) => exec.runWithChannel(policy, desc, bin, args, { lane: rec.lane, ...opts }),
    osascriptAdmin: (shellCmd, opts = {}) => exec.osascriptAdmin(shellCmd, { lane: rec.lane, ...opts }),
    openInFinder: (dir, opts = {}) => exec.openInFinder(dir, { lane: rec.lane, ...opts }),
  };
  return {
    params: rec.task.params,
    taskId: rec.task.id,
    lane: rec.lane,
    signal: rec.controller.signal,
    log: (level, text) => pushLog(rec, level, text),
    setChannel: () => { /* steps() 阶段无当前步骤，忽略 */ },
    exec: boundExec,
  };
}

/**
 * 构造单步执行上下文。
 * ★ 注入到 ctx.exec 的执行接口会把本步 AbortSignal **默认绑定**，
 *   即使模块调用 exec.run 时忘记传 signal，取消 / 超时依然能终止子进程；
 *   并同时注入本任务的 lane，使下载 / 安装子进程落在 music lane（设计 §5.2）。
 */
function makeStepCtx(rec, step, stepSignal) {
  const boundExec = {
    ...exec,
    run: (bin, args, opts = {}) => exec.run(bin, args, { signal: stepSignal, lane: rec.lane, ...opts }),
    runWithChannel: (policy, desc, bin, args, opts = {}) => exec.runWithChannel(policy, desc, bin, args, { signal: stepSignal, lane: rec.lane, ...opts }),
    osascriptAdmin: (shellCmd, opts = {}) => exec.osascriptAdmin(shellCmd, { signal: stepSignal, lane: rec.lane, ...opts }),
    openInFinder: (dir, opts = {}) => exec.openInFinder(dir, { signal: stepSignal, lane: rec.lane, ...opts }),
  };
  return {
    params: rec.task.params,
    taskId: rec.task.id,
    lane: rec.lane,
    signal: stepSignal,
    log: (level, text) => pushLog(rec, level, text),
    setChannel: (c) => { step.channel = c; },
    exec: boundExec,
  };
}

/**
 * 按步骤终态汇总 `{ ok, fail, skip }`（skip 含 cancelled）——全项目唯一口径。
 * @param {Array<{status:string}>} steps
 * @returns {{ok:number, fail:number, skip:number}}
 */
export function countSteps(steps) {
  const counts = { ok: 0, fail: 0, skip: 0 };
  for (const s of Array.isArray(steps) ? steps : []) {
    if (s.status === 'ok') counts.ok += 1;
    else if (s.status === 'fail') counts.fail += 1;
    else if (s.status === 'skip' || s.status === 'cancelled') counts.skip += 1;
  }
  return counts;
}

/** 已进入终态的步骤数（pending / running 之外的都算已结束），供 progress 展示。 */
function doneSteps(steps) {
  return steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length;
}

// ------------------------------ 提交与队列 ------------------------------
/** 提交一个任务（按 lane 排队：同 lane 串行、跨 lane 并行），返回任务快照。 */
export function submit(spec) {
  const { module, action, params = {}, actionDef } = spec;
  if (!actionDef || typeof actionDef.steps !== 'function') {
    throw new exec.AppError(exec.ERR.NOT_FOUND, '未知动作，无法创建任务');
  }
  // 缺省 lane 落 default：现有 7 个模块调用 submit() 不传 lane，行为与改动前完全等价。
  const laneName = typeof spec.lane === 'string' && spec.lane ? spec.lane : DEFAULT_LANE;

  const task = {
    id: newTaskId(),
    seq: seqCounter++,
    module,
    action,
    lane: laneName,
    title: actionDef.title || action,
    params: params || {},
    status: 'pending',
    steps: [],
    progress: { done: 0, total: 0 },
    counts: { ok: 0, fail: 0, skip: 0 },
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    error: null,
    logPath: '',
    cancellable: true,
  };
  task.logPath = store.logFilePath(task.id);

  const rec = {
    task, actionDef, logs: [], seq: 0,
    lane: laneName,
    emitter: new EventEmitter(),
    controller: new AbortController(),
    finished: false, started: false,
  };
  rec.emitter.setMaxListeners(0);
  records.set(task.id, rec);
  lane(laneName).queue.push(task.id);
  pump(laneName);
  return snapshotTask(task);
}

/** 队列泵：在指定 lane 内串行取下一个未完成任务执行。 */
function pump(laneName) {
  const L = lane(laneName);
  if (L.running) return;
  while (L.queue.length > 0) {
    const id = L.queue.shift();
    const rec = records.get(id);
    if (!rec || rec.finished) continue;
    L.running = true;
    L.currentId = id;
    runTask(rec).catch(() => { /* runTask 内部已兜底 */ }).finally(() => {
      L.running = false;
      L.currentId = null;
      pump(laneName);
    });
    return;
  }
}

/** 执行一个任务（内部兜底，不向外抛）。 */
async function runTask(rec) {
  const task = rec.task;
  const signal = rec.controller.signal;

  task.status = 'running';
  task.startedAt = Date.now();
  rec.started = true;
  emitTask(rec);
  pushLog(rec, 'info', `任务开始：${task.title}`);

  let plans = [];
  try {
    plans = rec.actionDef.steps(task.params, makeBaseCtx(rec)) || [];
    if (!Array.isArray(plans)) plans = [];
  } catch (err) {
    task.status = 'fail';
    task.error = exec.toErrObj(err);
    task.endedAt = Date.now();
    pushLog(rec, 'error', `步骤清单构建失败：${task.error.message}`);
    finishRecord(rec);
    return;
  }

  // 归一化：steps() 是模块自由代码，可能返回 null / 非对象 / 缺字段的条目。
  // 直接在 map 里读 p.id 一旦抛错，runTask 会 reject → pump 的 catch 吞掉异常、
  // 而 L.running 永远停在 true ⇒ 该 lane 从此彻底卡死（只能重启进程）。这里兜住。
  plans = plans.filter((p) => p && typeof p === 'object');
  task.steps = plans.map((p, i) => ({
    id: typeof p.id === 'string' && p.id ? p.id : `step_${i}`,
    title: typeof p.title === 'string' && p.title ? p.title : `步骤 ${i + 1}`,
    status: 'pending',
    channel: null,
    startedAt: null, endedAt: null, exitCode: null, error: null,
  }));
  task.progress.total = task.steps.length;
  emitTask(rec);

  let cancelled = false;

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const step = task.steps[i];

    if (signal.aborted) {
      cancelled = true;
      skipRemaining(rec, i);
      break;
    }

    step.status = 'running';
    step.startedAt = Date.now();
    emitTask(rec);
    pushLog(rec, 'info', `▶ ${step.title}`);

    const stepTimeout = typeof plan.timeoutMs === 'number' && plan.timeoutMs > 0 ? plan.timeoutMs : DEFAULT_STEP_TIMEOUT_MS;
    const stepCtrl = new AbortController();
    let stepTimedOut = false;
    const onTaskAbort = () => { try { stepCtrl.abort(); } catch { /* ignore */ } };
    signal.addEventListener('abort', onTaskAbort, { once: true });
    // ★ 硬超时：timer 只 abort 信号是不够的 —— 若 plan.run 内部没有把 signal 透给
    //   exec.run（或它在非子进程的 await 上挂住），单步会无限期占住 lane。
    //   这里额外用 Promise.race 让步骤一定在 stepTimeout 内落定为 fail。
    //   race 输掉的那条 promise 必须自带 catch，否则会变成 unhandledRejection。
    let timer = null;
    let hardTimeoutReject = null;
    const hardTimeout = new Promise((_, reject) => { hardTimeoutReject = reject; });
    timer = setTimeout(() => {
      stepTimedOut = true;
      try { stepCtrl.abort(); } catch { /* ignore */ }
      if (hardTimeoutReject) hardTimeoutReject(new exec.AppError(exec.ERR.TIMEOUT, `步骤超时（>${Math.round(stepTimeout / 1000)}s）`));
    }, stepTimeout);
    if (timer.unref) timer.unref();

    try {
      const stepRun = Promise.resolve().then(() => plan.run(makeStepCtx(rec, step, stepCtrl.signal)));
      stepRun.catch(() => { /* race 已定局时的迟到异常，忽略（真正处理在下方 race 结果） */ });
      await Promise.race([stepRun, hardTimeout]);
      if (signal.aborted) { cancelled = true; step.status = 'cancelled'; step.error = { code: exec.ERR.CANCELLED, message: '任务已取消' }; }
      else { step.status = 'ok'; }
    } catch (err) {
      if (signal.aborted) { cancelled = true; step.status = 'cancelled'; step.error = { code: exec.ERR.CANCELLED, message: '任务已取消' }; }
      else if (stepTimedOut) {
        step.status = 'fail';
        step.error = { code: exec.ERR.TIMEOUT, message: `步骤超时（>${Math.round(stepTimeout / 1000)}s）` };
        pushLog(rec, 'error', `✗ ${step.title} 超时（>${Math.round(stepTimeout / 1000)}s）`);
      } else {
        const obj = exec.toErrObj(err);
        if (obj.code === exec.ERR.CANCELLED) { cancelled = true; step.status = 'cancelled'; step.error = obj; }
        else if (obj.code === exec.ERR.AUTH_CANCELLED || obj.code === 'SKIP') { step.status = 'skip'; step.error = obj; } // -128 授权取消 / 主动跳过 → skip
        else { step.status = 'fail'; step.error = obj; }
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onTaskAbort);
    }

    step.endedAt = Date.now();
    if (step.channel) pushLog(rec, 'info', `  通道：${step.channel === 'proxy' ? '代理' : '直连'}`);
    if (step.status === 'ok') pushLog(rec, 'ok', `✓ ${step.title} 完成`);
    else if (step.status === 'skip') pushLog(rec, 'warn', `⏭ ${step.title} 已跳过`);
    task.progress.done = doneSteps(task.steps);
    emitTask(rec);

    if (cancelled) { skipRemaining(rec, i + 1); break; }
  }

  // ---- 汇总 ----
  const counts = countSteps(task.steps);
  task.counts = counts;
  task.progress.done = doneSteps(task.steps);

  if (cancelled || signal.aborted) {
    task.status = 'cancelled';
    task.error = { code: exec.ERR.CANCELLED, message: '任务已取消' };
    pushLog(rec, 'warn', `任务已取消，剩余 ${task.steps.filter((s) => s.status === 'skip').length} 步跳过`);
    pushLog(rec, 'info', '已完成的步骤不会回滚（brew upgrade / untap / 文件写入均不可回滚）');
  } else if (counts.fail > 0) {
    task.status = 'fail';
    const firstFail = task.steps.find((s) => s.status === 'fail');
    task.error = firstFail && firstFail.error ? firstFail.error : { code: exec.ERR.CMD_FAILED, message: '任务失败' };
  } else {
    task.status = 'ok';
  }

  // 允许动作自定义终态（扩展点：如 unseal 的"全失败才算 fail"语义）
  if (typeof rec.actionDef.finalize === 'function') {
    try { rec.actionDef.finalize(task, { log: (level, text) => pushLog(rec, level, text) }); } catch { /* 不影响收尾 */ }
  }

  task.endedAt = Date.now();
  pushLog(rec, 'info', `任务结束：${statusLabel(task.status)}（成功 ${counts.ok} / 失败 ${counts.fail} / 跳过 ${counts.skip}）`);
  finishRecord(rec);
}

/** 把 from 起所有 pending 步骤置 skip。 */
function skipRemaining(rec, from) {
  for (let j = from; j < rec.task.steps.length; j++) {
    if (rec.task.steps[j].status === 'pending') {
      rec.task.steps[j].status = 'skip';
    }
  }
}

function statusLabel(status) {
  if (status === 'ok') return '成功';
  if (status === 'fail') return '失败';
  if (status === 'cancelled') return '已取消';
  return status;
}

/** 收尾：写历史、发 done、内存裁剪。 */
function finishRecord(rec) {
  if (rec.finished) return;
  rec.finished = true;
  rec.task.cancellable = false;
  try { store.writeHistory(rec.task); } catch { /* 历史写失败不阻断 */ }
  try { store.pruneLogs(); } catch { /* ignore */ }
  emit(rec, { type: 'done', taskId: rec.task.id, task: snapshotTask(rec.task) });
  pruneMemory();
}

function pruneMemory() {
  if (records.size <= MEMORY_KEEP) return;
  const finished = [...records.values()].filter((r) => r.finished).sort((a, b) => (a.task.createdAt || 0) - (b.task.createdAt || 0));
  let excess = records.size - MEMORY_KEEP;
  for (const r of finished) {
    if (excess <= 0) break;
    if (r.emitter.listenerCount('event') > 0) continue; // 有活跃订阅则暂不回收
    records.delete(r.task.id);
    excess -= 1;
  }
}

// ------------------------------ 查询 ------------------------------
/** 获取任务快照（内存优先，回落历史）。 */
export function getTask(taskId) {
  const rec = records.get(taskId);
  if (rec) return snapshotTask(rec.task);
  return store.readHistory(taskId) || null;
}

/** 列出任务（内存中的运行中 + 最近）；内存为空时回落最近历史，供刷新 / 重启恢复展示。 */
export function listTasks() {
  const mem = [...records.values()].map((r) => snapshotTask(r.task)).sort((a, b) => b.createdAt - a.createdAt);
  if (mem.length >= TASKS_LIST_KEEP) return mem.slice(0, TASKS_LIST_KEEP);
  const seen = new Set(mem.map((t) => t.id));
  const extra = [];
  try {
    for (const h of store.listHistory()) {
      if (seen.has(h.id)) continue;
      extra.push({
        id: h.id, seq: h.seq, module: h.module, action: h.action, title: h.title,
        params: {}, status: h.status, steps: [], progress: { done: 0, total: 0 },
        counts: h.counts || { ok: 0, fail: 0, skip: 0 },
        createdAt: h.startedAt || 0, startedAt: h.startedAt ?? null, endedAt: h.endedAt ?? null,
        error: null, logPath: store.logFilePath(h.id), cancellable: false,
      });
      if (mem.length + extra.length >= TASKS_LIST_KEEP) break;
    }
  } catch { /* ignore */ }
  return mem.concat(extra);
}

/** 获取 SSE 连接初始快照 { task, logs }。 */
export function getSnapshot(taskId) {
  const task = getTask(taskId);
  if (!task) return null;
  const rec = records.get(taskId);
  const logs = rec ? rec.logs.map((l) => ({ ...l })) : store.readLog(taskId);
  return { task, logs };
}

/** 订阅任务事件（SSE）；返回取消订阅函数。 */
export function subscribe(taskId, handler) {
  const rec = records.get(taskId);
  if (!rec) return () => {};
  const wrapped = (evt) => { try { handler(evt); } catch { /* ignore */ } };
  rec.emitter.on('event', wrapped);
  return () => { try { rec.emitter.off('event', wrapped); } catch { /* ignore */ } };
}

export function isFinished(taskId) {
  const rec = records.get(taskId);
  if (rec) return rec.finished;
  const t = store.readHistory(taskId);
  return !!t && (t.status === 'ok' || t.status === 'fail' || t.status === 'cancelled');
}

// ------------------------------ 取消 ------------------------------
/** 请求取消任务；返回是否受理。 */
export function cancel(taskId) {
  const rec = records.get(taskId);
  if (!rec || rec.finished) return false;

  if (rec.task.status === 'pending' || !rec.started) {
    rec.task.status = 'cancelled';
    rec.task.error = { code: exec.ERR.CANCELLED, message: '任务已取消' };
    rec.task.endedAt = Date.now();
    pushLog(rec, 'warn', '任务在开始前被取消');
    finishRecord(rec);
    return true;
  }

  pushLog(rec, 'warn', '收到取消请求，正在终止当前子进程（SIGTERM→3s→SIGKILL）…');
  try { rec.controller.abort(); } catch { /* ignore */ }
  return true;
}

/** 是否有**任一** lane 正在执行任务（waitForIdle 依赖它）。 */
export function isBusy() { return [...LANES.values()].some((l) => l.running); }

/**
 * 当前运行任务 id（default lane）。
 * ★ 保持向后兼容：原语义即「全局唯一运行任务 id」，现在等价于 default lane 的当前任务。
 */
export function currentTaskId() { return lane(DEFAULT_LANE).currentId; }

/** 所有 lane 的当前运行任务 id（不含空槽），供 gracefulShutdown 逐任务取消。 */
export function activeTaskIds() {
  return [...LANES.values()].map((l) => l.currentId).filter((id) => typeof id === 'string' && id.length > 0);
}

/**
 * 立即整组强杀当前所有存活子进程（SIGKILL，不等宽限期）。
 *
 * 只供 `server.js` 的 `gracefulShutdown` 在「等任务结束」超时后调用：正常取消走
 * `cancel()` 的 SIGTERM → 3s → SIGKILL；而进程即将退出时，exec 内部那个兜底定时器
 * 会被 `process.exit` 直接丢弃，忽略 SIGTERM 的子进程就会变成孤儿。退出前补这一刀。
 *
 * @returns {number} 实际尝试发信号的子进程数
 */
export function forceKill() { return exec.killAllNow('SIGKILL'); }
