/**
 * MacKit · 图标生成器（开发工具，零依赖）
 *
 * 为什么用代码画而不是塞一张 PNG：
 *   - 仓库里不需要放二进制源文件，图标「怎么来的」一目了然、可复现；
 *   - 想改配色 / 形状，改几个常量重跑即可，不必找设计工具。
 *
 * 用法（只需 Node，无需安装任何东西）：
 *   node tools/make-icon.mjs          → 生成 assets/mackit-icon-1024.png
 *
 * 再由 macOS 自带工具打成 .icns（本脚本不调用子进程，保持零依赖）：
 *   mkdir -p /tmp/MacKit.iconset
 *   for pair in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
 *               "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
 *               "512 icon_256x256@2x" "512 icon_512x512"; do
 *     set -- $pair
 *     sips -z $1 $1 assets/mackit-icon-1024.png --out /tmp/MacKit.iconset/$2.png >/dev/null
 *   done
 *   cp assets/mackit-icon-1024.png /tmp/MacKit.iconset/icon_512x512@2x.png
 *   iconutil -c icns /tmp/MacKit.iconset -o assets/MacKit.icns
 *
 * 设计：遵循 macOS Big Sur 图标规范 —— 1024×1024 画布，内容区 824×824 居中，
 *       圆角半径 185.4；蓝色对角渐变 + 白色「工具箱」（箱体 + 提手 + 盖缝）。
 *       渲染用 SDF（有符号距离场）+ 覆盖率抗锯齿，无需 canvas 之类的依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 参数（想调外观改这里）
// ---------------------------------------------------------------------------
/** 输出尺寸（同时是渲染尺寸） */
const SIZE = 1024;
/** 渐变起点色 / 终点色（左上 → 右下） */
const COLOR_FROM = [88, 162, 255];
const COLOR_TO = [24, 78, 214];
/** 左上角柔和高光的中心与半径、峰值不透明度 */
const GLOW = { cx: 300, cy: 210, r: 820, alpha: 0.22 };

/** Big Sur 内容区（1024 画布下留白 100，圆角 185.4） */
const PLATE = { cx: 512, cy: 512, hw: 412, hh: 412, r: 185.4 };

/** 工具箱三个部件（垂直方向已整体居中：提手外顶 284.5 ~ 箱体底 739.5，中心 512） */
const HANDLE = { cx: 512, cy: 435.5, R: 128, halfW: 23, yMax: 435.5 };  // 提手（上半环，线宽 46）
const BOX = { cx: 512, cy: 587.5, hw: 234, hh: 152, r: 46 };            // 箱体 468×304
const SEAM = { cx: 512, cy: 521, hw: 234, hh: 4 };                      // 盖缝（透出背景色）

const OUT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/mackit-icon-1024.png');

// ---------------------------------------------------------------------------
// 有符号距离场（负数 = 在形状内）
// ---------------------------------------------------------------------------
/**
 * 圆角矩形 SDF。
 * @returns {number} 到边界的距离（内部为负）
 */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 圆环 SDF（用来画提手）。 */
function sdRing(px, py, cx, cy, R, halfW) {
  return Math.abs(Math.hypot(px - cx, py - cy) - R) - halfW;
}

/** 覆盖率：把距离场边缘转成 0~1 的透明度（抗锯齿宽度约 1.2px）。 */
function cover(d, w = 1.2) {
  return Math.min(1, Math.max(0, 0.5 - d / w));
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function render() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const spanTotal = (PLATE.hw * 2) + (PLATE.hh * 2);   // 对角渐变的分母

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const covPlate = cover(sdRoundRect(px, py, PLATE.cx, PLATE.cy, PLATE.hw, PLATE.hh, PLATE.r));
      if (covPlate <= 0) continue;   // 画布外保持透明

      // —— 背景：对角渐变 + 左上柔光 ——
      const t = clamp01(((px - (PLATE.cx - PLATE.hw)) + (py - (PLATE.cy - PLATE.hh))) / spanTotal);
      let cr = lerp(COLOR_FROM[0], COLOR_TO[0], t);
      let cg = lerp(COLOR_FROM[1], COLOR_TO[1], t);
      let cb = lerp(COLOR_FROM[2], COLOR_TO[2], t);

      const glow = Math.pow(Math.max(0, 1 - Math.hypot(px - GLOW.cx, py - GLOW.cy) / GLOW.r), 2) * GLOW.alpha;
      cr += (255 - cr) * glow;
      cg += (255 - cg) * glow;
      cb += (255 - cb) * glow;

      // —— 前景：白色工具箱 =（提手 ∪ 箱体）− 盖缝 ——
      // 并集用 min，差集用 max(a, -b)：缝的位置不放白色，背景自然透出来。
      const dHandle = Math.max(sdRing(px, py, HANDLE.cx, HANDLE.cy, HANDLE.R, HANDLE.halfW), py - HANDLE.yMax);
      const dBox = sdRoundRect(px, py, BOX.cx, BOX.cy, BOX.hw, BOX.hh, BOX.r);
      const dSeam = sdRoundRect(px, py, SEAM.cx, SEAM.cy, SEAM.hw, SEAM.hh, 0);
      const covWhite = cover(Math.max(Math.min(dHandle, dBox), -dSeam));

      cr += (255 - cr) * covWhite;
      cg += (255 - cg) * covWhite;
      cb += (255 - cb) * covWhite;

      const i = (y * SIZE + x) * 4;
      buf[i] = Math.round(cr);
      buf[i + 1] = Math.round(cg);
      buf[i + 2] = Math.round(cb);
      buf[i + 3] = Math.round(covPlate * 255);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// PNG 编码（手写最小实现：IHDR + IDAT + IEND，8bit RGBA）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  // 每行前置一个 filter 字节（0 = None）
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 6;    // 颜色类型：真彩 + Alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, encodePng(SIZE, SIZE, render()));
console.log(`已生成 ${path.relative(process.cwd(), OUT_FILE)}（${SIZE}×${SIZE}）`);
