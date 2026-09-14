/*
 * loupe.ts —— 放大镜。
 *
 * 读像素 → 最近邻放大 → 像素网格 → 2D 覆盖层画取样框。
 *
 * 三块画布的分工：
 *   glCanvas       设备像素就是 GL 缓冲，读像素的唯一来源
 *   overlayCanvas  2D，设备像素与 GL 缓冲 1:1，只画取样框，指针事件穿透
 *   loupeCanvas    2D，把源设备像素按整格最近邻放大；网格线画在源的像素边界上
 *
 * 这里刻意不往放大镜里补任何反走样：网格必须落在真实的像素格上，
 * 否则"看到设备像素"这件事就不成立了。
 *
 * 模块只依赖一个 `readBlock` 回调（由 renderer 提供），不直接持有 GL。
 */

import type { RGBA } from '../color';
import { parseColor, toCss, toHex, toHexA } from '../color';

/** 放大镜一帧的尺寸信息（CSS 像素 + DPR，全部由 main 测量后喂进来）。 */
export interface LoupeView {
  /** 取样点相对表盘左上角的 CSS 坐标。 */
  x: number;
  y: number;
  /** 表盘的 CSS 边长（\`dial\` 是正方形）。 */
  cssSize: number;
  /** GL 缓冲的设备像素边长（正方形，见 README §7.1）。 */
  glSize: number;
  /** 设备像素比。 */
  dpr: number;
}

/** 放大镜中心像素的读数，由 main 节流后写进 #loupeHex / #loupeCoord。 */
export interface LoupeReadout {
  hex: string;
  coord: string;
}

/** 覆盖层的设备像素边长。 */
export interface LoupeLayout {
  overlaySize: number;
  loupeSize: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 源窗口边长的下限（设备像素）：再小就没法判断自己在看一格还是几格。 */
const MIN_SPAN = 4;
/** 存储用的上界；真正的上界是画布与表盘设备像素的较小者，在 draw 里钳。 */
const MAX_SPAN = 4096;

/** 中心像素读数：`#rrggbb`（不透明）或 `#rrggbbaa`，外加坐标。 */
function readout(
  sample: RGBA | null,
  samplePixel: { x: number; y: number } | null,
  srcW: number,
): LoupeReadout {
  const hex = sample ? (sample.a >= 0.999 ? toHex(sample) : toHexA(sample)) : '--';
  const coord = samplePixel ? `${samplePixel.x},${samplePixel.y}·${srcW}px` : '--';
  return { hex, coord };
}

/** 读一块 GL 像素（GL 行序，原点左下）。 */
export type ReadBlock = (x: number, y: number, w: number, h: number) => Uint8Array;

export class Loupe {
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly root: HTMLElement;

  /** 源窗口边长（设备像素）：越小放大越多；等于画布宽即 1 倍。 */
  private spanPx = 11;
  private showGrid = true;

  /** 放大后的画面，逐帧复用，避免每帧新建 ImageData。 */
  private image: ImageData | null = null;
  /** 反向映射：放大镜像素 → 源块像素，源块尺寸不变时不重建。 */
  private mapX: Int32Array | null = null;
  private mapY: Int32Array | null = null;
  private mapCanvasW = 0;
  private mapCanvasH = 0;
  private mapSrcW = 0;
  private mapSrcH = 0;

  private colorsDirty = true;
  private samplerColor = '#5ba88c';

  constructor(root: HTMLElement, overlay: HTMLCanvasElement, canvas: HTMLCanvasElement) {
    const overlayCtx = overlay.getContext('2d', { alpha: true });
    if (!overlayCtx) throw new Error('覆盖层：无法获取 2D 上下文。');
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('放大镜：无法获取 2D 上下文。');
    this.overlay = overlay;
    this.overlayCtx = overlayCtx;
    this.canvas = canvas;
    this.ctx = ctx;
    this.root = root;
  }

  /** 当前源窗口边长（设备像素）。 */
  get span(): number {
    return this.spanPx;
  }

  /** 设置源窗口边长（设备像素），返回实际生效值。 */
  setSpan(px: number): number {
    const raw = Number.isFinite(px) ? px : this.spanPx;
    this.spanPx = clamp(Math.round(raw), MIN_SPAN, MAX_SPAN);
    return this.spanPx;
  }

  setGrid(on: boolean): void {
    this.showGrid = on;
  }

  /** 主题换了以后重读覆盖层要用的颜色。 */
  invalidateColors(): void {
    this.colorsDirty = true;
  }

  /**
   * 把覆盖层与放大镜画布的绘制缓冲对齐到设备像素。
   *
   * 覆盖层的绘制缓冲刻意取成 `glSize`（而不是 cssSize × DPR）：它是"设备像素
   * 叠加层"，只有与 GL 缓冲逐像素对齐，取样框才能落在真正被采样的那一格上。
   * 尺寸被钳进 [256, 1024] 时 CSS 只是把覆盖层拉伸一点点，不影响对齐关系。
   * 放大镜面板的 CSS 尺寸随窄屏媒体查询变化，所以每帧读 clientWidth 最稳。
   */
  resize(glSize: number, dpr: number): LoupeLayout {
    const ratio = dpr > 0 ? dpr : 1;
    const overlaySize = Math.max(1, Math.round(glSize));
    if (this.overlay.width !== overlaySize || this.overlay.height !== overlaySize) {
      this.overlay.width = overlaySize;
      this.overlay.height = overlaySize;
    }
    const cssLoupe = this.canvas.clientWidth > 0 ? this.canvas.clientWidth : this.canvas.width || 132;
    const loupeSize = Math.max(1, Math.round(cssLoupe * ratio));
    if (this.canvas.width !== loupeSize || this.canvas.height !== loupeSize) {
      this.canvas.width = loupeSize;
      this.canvas.height = loupeSize;
    }
    return { overlaySize, loupeSize };
  }

  /**
   * 画一帧：放大镜内容 + 覆盖层取样框。
   * `sample` 是取样点本身的颜色（由 renderer 单点读出，可能为 null）。
   */
  draw(
    view: LoupeView,
    sample: RGBA | null,
    samplePixel: { x: number; y: number } | null,
    readBlock: ReadBlock,
  ): LoupeReadout | null {
    if (this.colorsDirty) this.syncColors();

    const capW = this.canvas.width;
    const capH = this.canvas.height;
    const overlaySize = this.overlay.width;
    const glSize = view.glSize;
    if (capW < 2 || capH < 2 || overlaySize < 2 || glSize < 2) return null;

    // 取样点落在哪个设备像素上（GL / 覆盖层坐标，原点左上）。
    const ox = clamp(Math.floor((view.x / view.cssSize) * glSize), 0, glSize - 1);
    const oy = clamp(Math.floor((view.y / view.cssSize) * glSize), 0, glSize - 1);

    // 源窗口边长（设备像素）：窗口越小放大越多。上界取画布与表盘设备像素的
    // 较小者，免得窗口比源还大——那会拉伸取样，看到的就不是设备像素了。
    const srcW = clamp(this.spanPx, MIN_SPAN, Math.min(capW, glSize));
    const srcH = Math.min(srcW, capH);

    // 让取样点尽量居中，同时不越出表盘。
    const bx = clamp(ox - (srcW >> 1), 0, Math.max(0, glSize - srcW));
    const by = clamp(oy - (srcH >> 1), 0, Math.max(0, glSize - srcH));

    // 覆盖层行序（原点左上）→ GL 行序（原点左下）。
    const glY = glSize - (by + srcH);
    const block = readBlock(bx, glY, srcW, srcH);
    // block 的第 r 行是 GL 行 glY + r，对应覆盖层的行 (by + r)；
    // 放大镜要"上=表盘上"，所以从块底行开始索引。
    const rowOffset = srcH - 1;
    // 取样格在块内的下标——描边描的就是 loupeHex 读的那一格。
    const markX = ox - bx;
    const markY = oy - by;

    this.ensureMap(capW, capH, srcW, srcH);
    const mapX = this.mapX;
    const mapY = this.mapY;
    const image = this.image;
    if (!mapX || !mapY || !image) return null;

    const data = image.data;
    let any = false;
    for (let i = 0; i < mapX.length; i++) {
      const sx = mapX[i] ?? 0;
      const sy = mapY[i] ?? 0;
      const r = rowOffset - sy;
      const dst = i * 4;
      if (r < 0 || r >= srcH || sx < 0 || sx >= srcW) {
        data[dst] = 0;
        data[dst + 1] = 0;
        data[dst + 2] = 0;
        data[dst + 3] = 0;
        continue;
      }
      const src = (r * srcW + sx) * 4;
      data[dst] = block[src] ?? 0;
      data[dst + 1] = block[src + 1] ?? 0;
      data[dst + 2] = block[src + 2] ?? 0;
      data[dst + 3] = 255;
      any = true;
    }

    this.ctx.clearRect(0, 0, capW, capH);
    if (any) this.ctx.putImageData(image, 0, 0);
    if (this.showGrid) this.strokeGrid(capW, capH, srcW, srcH);
    this.strokeCell(capW, capH, srcW, srcH, markX, markY, view.dpr);

    this.drawOverlay(ox, oy, bx, by, srcW, srcH);
    return readout(sample, samplePixel, srcW);
  }

  /** 只清掉覆盖层（放大镜隐藏时用）。 */
  clearOverlay(): void {
    if (this.overlay.width > 0 && this.overlay.height > 0) {
      this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }
  }

  /* ── 内部 ─────────────────────────────────────────────── */

  private drawOverlay(
    ox: number,
    oy: number,
    bx: number,
    by: number,
    srcW: number,
    srcH: number,
  ): void {
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const lw = Math.max(1, Math.round(this.overlay.width / 512));
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = this.samplerColor;
    ctx.strokeRect(bx + lw / 2, by + lw / 2, srcW - lw, srcH - lw);
    // 中心那一格单独描一下，肉眼能对上 loupeHex 读的是哪一个像素。
    ctx.strokeRect(ox + lw / 2, oy + lw / 2, 1 - lw, 1 - lw);
    ctx.restore();
  }

  private ensureMap(capW: number, capH: number, srcW: number, srcH: number): void {
    if (
      this.image !== null &&
      this.mapCanvasW === capW &&
      this.mapCanvasH === capH &&
      this.mapSrcW === srcW &&
      this.mapSrcH === srcH
    ) {
      return;
    }
    const total = capW * capH;
    const mapX = new Int32Array(total);
    const mapY = new Int32Array(total);
    for (let dy = 0; dy < capH; dy++) {
      const sy = Math.min(srcH - 1, Math.floor((dy * srcH) / capH));
      for (let dx = 0; dx < capW; dx++) {
        const sx = Math.min(srcW - 1, Math.floor((dx * srcW) / capW));
        const i = dy * capW + dx;
        mapX[i] = sx;
        mapY[i] = sy;
      }
    }
    this.mapX = mapX;
    this.mapY = mapY;
    this.mapCanvasW = capW;
    this.mapCanvasH = capH;
    this.mapSrcW = srcW;
    this.mapSrcH = srcH;
    this.image = this.ctx.createImageData(capW, capH);
  }

  /** 沿源像素边界画网格：亮暗各一条，任何底色上都看得见。 */
  private strokeGrid(capW: number, capH: number, srcW: number, srcH: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? 'rgba(255, 255, 255, 0.32)' : 'rgba(0, 0, 0, 0.32)';
      const shift = pass === 0 ? 0.5 : 1.5;
      ctx.beginPath();
      for (let i = 0; i <= srcW; i++) {
        const x = Math.round((i * capW) / srcW) + shift;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, capH);
      }
      for (let j = 0; j <= srcH; j++) {
        const y = Math.round((j * capH) / srcH) + shift;
        ctx.moveTo(0, y);
        ctx.lineTo(capW, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 取样格的描边：这一格就是 loupeHex 读的那个像素，两者必须对得上。 */
  private strokeCell(
    capW: number,
    capH: number,
    srcW: number,
    srcH: number,
    markX: number,
    markY: number,
    dpr: number,
  ): void {
    const ix = clamp(markX, 0, srcW - 1);
    const iy = clamp(markY, 0, srcH - 1);
    // 放大镜里的纵轴不翻转：块的底行（覆盖层靠下）画在画布靠下。
    const row = srcH - 1 - iy;
    const x = Math.round((ix * capW) / srcW);
    const x1 = Math.round(((ix + 1) * capW) / srcW);
    const y = Math.round((row * capH) / srcH);
    const y1 = Math.round(((row + 1) * capH) / srcH);
    const w = Math.max(1, x1 - x);
    const h = Math.max(1, y1 - y);
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.strokeStyle = this.samplerColor;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
    ctx.restore();
  }

  private syncColors(): void {
    this.colorsDirty = false;
    const css = getComputedStyle(this.root).getPropertyValue('--accent').trim();
    if (css === '') return;
    const accent = parseColor(css);
    // 取样框画在真实像素色之上，用满不透明的强调色保证任何底色上都读得出来。
    this.samplerColor = toCss({ ...accent, a: 1 });
  }
}
