// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/*
 * main.ts —— 装配与主循环。
 *
 * 把 DOM 契约（index.html 的 id / data-*）、renderer、time-model、loupe、
 * theme controller 接到一起。这里是唯一读写 #fatal 的地方，也是唯一的 rAF 起点。
 */

import { ClockRenderer } from './clock/renderer';
import type { ClockAngles, DialHand, TickMotion } from './clock/time-model';
import {
  CIRCLE_MS,
  TimeModel,
  formatClock,
  nowMs,
  pointerAngle,
  wrapPi,
} from './clock/time-model';
import { Loupe } from './clock/loupe';
import { DIAL } from './clock/DIAL';
import { ThemeController } from './themes/controller';
import './styles.css';

/**
 * 设备像素边长的下限与天花板（README §7.1）。
 * 天花板不是性能护栏：真实屏幕碰不到它（4096 的 CSS 边长约为 5700px 高的视口），
 * 只用来兜住 GL 缓冲尺寸上限那类硬失败。性能由超采样档位自己体现。
 */
const MIN_SIDE = 256;
const MAX_SIDE = 4096;

/** 并排时放大镜占的横向空间：面板 168 + 与表盘的间距 22。 */
const LOUPE_BESIDE_PX = 190;
/** .stage 的左右内边距（与 styles.css 保持一致）。 */
const STAGE_PADDING_PX = 26;

const samplesPerAxis = (n: number): number => n * n;

/** 拖动换算用的半圈弧度比例系数。 */
const TWO_PI = Math.PI * 2;

/** 时区选项：纯整点偏移，UTC-11 … UTC+0 … UTC+11，不绑定具体地区。 */
const TZ_MIN = -11;
const TZ_MAX = 11;

/** 选项文案：UTC+8 / UTC+0 / UTC-11。 */
const zoneLabel = (hours: number): string => `UTC${hours >= 0 ? `+${hours}` : String(hours)}`;

/** 初值取自浏览器时区，取整到整点并钳进可选范围。 */
function initialZoneHours(): number {
  const hours = Math.round(-new Date().getTimezoneOffset() / 60);
  return hours < TZ_MIN ? TZ_MIN : hours > TZ_MAX ? TZ_MAX : hours;
}

/* ── 取 DOM ─────────────────────────────────────────────── */

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少必需的 DOM 节点 #${id}`);
  return el as T;
}

function optional<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/* ── 启动 ───────────────────────────────────────────────── */

function boot(): void {
  const fatal = optional<HTMLElement>('fatal');
  const fatalText = optional<HTMLElement>('fatalText');
  const report = (reason: string): void => {
    if (fatalText) fatalText.textContent = reason;
    if (fatal) fatal.hidden = false;
  };

  let app: App;
  try {
    app = new App(report);
  } catch (err) {
    report(err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    app.start();
  } catch (err) {
    report(err instanceof Error ? err.message : String(err));
  }
}

/* ── 应用 ───────────────────────────────────────────────── */

/** 每帧重算的读数文本。 */
interface Readouts {
  clock: string;
  stats: string;
  hex: string;
  coord: string;
}

class App {
  private readonly report: (reason: string) => void;

  private readonly dial: HTMLElement;
  private readonly glCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly loupePanel: HTMLElement;
  private readonly loupeCanvas: HTMLCanvasElement;
  private readonly clockText: HTMLElement;
  private readonly statsText: HTMLElement;
  private readonly hexText: HTMLElement;
  private readonly coordText: HTMLElement;
  private readonly samplesGroup: HTMLElement;
  private readonly samplesValue: HTMLElement;
  private readonly samplesRange: HTMLInputElement;
  private readonly themeSelect: HTMLSelectElement | null;
  private readonly timezoneSelect: HTMLSelectElement | null;
  private readonly analyticButtons: HTMLButtonElement[];
  private readonly linearButtons: HTMLButtonElement[];
  private readonly tickButtons: HTMLButtonElement[];
  private readonly fieldBtn: HTMLButtonElement;
  private readonly gridBtn: HTMLButtonElement;
  private readonly loupeBtn: HTMLButtonElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly consolePanel: HTMLElement;
  private readonly collapseBtn: HTMLButtonElement;
  private readonly expandBtn: HTMLButtonElement;

  private readonly time = new TimeModel();
  private readonly renderer: ClockRenderer;
  private readonly loupe: Loupe;
  private readonly theme: ThemeController;

  /** true = 解析覆盖；false = 超采样（n = 1 即 1 点/像素）。 */
  private analytic = false;
  private samples = 1;
  private linear = false;
  private field = false;
  /** 默认视图：先把钟面本身给出来，网格与放大镜按需再开。 */
  private grid = false;
  private loupeOn = false;
  /** 控制台收起后，底部那一行让给表盘。 */
  private consoleCollapsed = false;

  private dpr = 1;
  private cssSide = 0;

  /** 指针在表盘内的位置（CSS 像素）；离开后保留最后一次画面，不再读像素。 */
  private pointer: { x: number; y: number } | null = null;
  private dragging = false;
  /** 本次拖动是否由我们代你暂停（手动按的暂停不算）。 */
  private pausedByDrag = false;
  private dragHand: DialHand = 'minute';
  private lastAngle = 0;

  /** 当前时区：整点偏移小时数（-11 … +11），初值取自浏览器。 */
  private zoneHours = 0;

  private frameTimes: number[] = [];
  private fps = 0;
  private frames = 0;
  private lastStatsPaint = 0;
  private readouts: Readouts = { clock: '', stats: '', hex: '--', coord: '--' };

  constructor(report: (reason: string) => void) {
    this.report = report;

    this.dial = must<HTMLElement>('dial');
    this.glCanvas = must<HTMLCanvasElement>('glCanvas');
    this.overlayCanvas = must<HTMLCanvasElement>('overlayCanvas');
    this.loupePanel = must<HTMLElement>('loupe');
    this.loupeCanvas = must<HTMLCanvasElement>('loupeCanvas');
    this.clockText = must<HTMLElement>('clockText');
    this.statsText = must<HTMLElement>('statsText');
    this.hexText = must<HTMLElement>('loupeHex');
    this.coordText = must<HTMLElement>('loupeCoord');
    this.samplesGroup = must<HTMLElement>('samplesGroup');
    this.samplesValue = must<HTMLElement>('samplesValue');
    this.samplesRange = must<HTMLInputElement>('samples');
    this.themeSelect = optional<HTMLSelectElement>('themeSelect');
    this.timezoneSelect = optional<HTMLSelectElement>('timezoneSelect');
    this.fieldBtn = must<HTMLButtonElement>('fieldBtn');
    this.gridBtn = must<HTMLButtonElement>('gridBtn');
    this.loupeBtn = must<HTMLButtonElement>('loupeBtn');
    this.pauseBtn = must<HTMLButtonElement>('pauseBtn');
    this.resetBtn = must<HTMLButtonElement>('resetBtn');
    this.consolePanel = must<HTMLElement>('console');
    this.collapseBtn = must<HTMLButtonElement>('collapseBtn');
    this.expandBtn = must<HTMLButtonElement>('expandBtn');

    this.analyticButtons = Array.from(
      must<HTMLElement>('modeSeg').querySelectorAll<HTMLButtonElement>('button[data-analytic]'),
    );
    this.linearButtons = Array.from(
      must<HTMLElement>('gammaSeg').querySelectorAll<HTMLButtonElement>('button[data-linear]'),
    );
    this.tickButtons = Array.from(
      must<HTMLElement>('tickSeg').querySelectorAll<HTMLButtonElement>('button[data-tick]'),
    );

    // 尺寸：dial 是正方形，取边长 × DPR 后只保留下限与天花板。
    const side = sideFor(this.dial, 1);
    this.renderer = new ClockRenderer(this.glCanvas, side);
    this.loupe = new Loupe(document.documentElement, this.overlayCanvas, this.loupeCanvas);
    // 调色板由 controller.start() 在首帧之前送来。
    this.theme = new ThemeController(
      { setPalette: (p) => this.renderer.setPalette(p) },
      this.themeSelect,
    );

    // 初始化期的 GL 失败要立刻可见，不能等到第一帧。
    this.glCanvas.addEventListener('webglcontextlost', (ev: Event) => {
      ev.preventDefault();
      this.report('WebGL2 上下文丢失（webglcontextlost）。请刷新页面重试。');
    });
  }

  start(): void {
    this.theme.start();
    // 网格状态以这里的字段为准，不复用 Loupe 内部的默认值。
    this.loupe.setGrid(this.grid);
    this.samples = Number.parseInt(this.samplesRange.value, 10) || 1;
    this.bindControls();
    this.bindTimeZone();
    this.bindPointer();
    this.bindKeys();
    this.syncControls();
    // 初始状态也要落一次光标策略（放大镜默认是开的）。
    this.setLoupe(this.loupeOn);
    this.resize();
    this.loupe.invalidateColors();

    window.addEventListener('resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(this.dial);
    }
    requestAnimationFrame(this.loop);
  }

  /* ── 布局 ─────────────────────────────────────────────── */

  /** 把 dial 的设备像素边长钳进允许范围，并让 GL / 覆盖层 / 放大镜三块画布对齐。 */
  private resize(): void {
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const side = sideFor(this.dial, dpr);
    const cssSide = this.dial.clientWidth || side / dpr;
    this.dpr = dpr;
    this.cssSide = cssSide;
    // 表盘优先：右边放得下就把放大镜挂在表盘外，放不下才收回表盘内叠放。
    // 判断用实算而不是断点——它取决于表盘当刻的实际宽度。
    const need = cssSide + LOUPE_BESIDE_PX + STAGE_PADDING_PX * 2;
    this.dial.classList.toggle('loupe-overlay', need > window.innerWidth);
    this.renderer.resize(side);
    this.loupe.resize(side, dpr);
  }

  /* ── 主循环 ───────────────────────────────────────────── */

  private loop = (rafTime: number): void => {
    this.tick(rafTime);
    requestAnimationFrame(this.loop);
  };
  private tick = (rafTime: number): void => {
    // 每帧都按真实时钟取时间，rAF 的时间戳与 Date.now 的基准不同，不用它。
    const now = nowMs();
    const angles = this.time.angles(now);
    const glow = this.time.tick === 'continuous' ? 1 : 0;

    this.renderer.draw({
      analytic: this.analytic,
      samples: this.samples,
      field: this.field,
      linear: this.linear,
      glow,
      angles: [angles.hour, angles.minute, angles.second],
    });

    this.drawLoupe();

    const parts = this.time.clockParts(now);
    this.readouts.clock = formatClock(parts, this.time.tick);
    this.updateFps(rafTime);
    this.paintReadouts(rafTime);
  };

  private drawLoupe(): void {
    if (!this.loupeOn) {
      this.loupe.clearOverlay();
      return;
    }
    // 取样点：指针最后一次落点；还没指过任何地方时用表盘中心。
    // 空面板会让人以为放大镜坏了。（README §4.3）
    const point = this.pointer ?? { x: this.cssSide * 0.5, y: this.cssSide * 0.5 };

    const glSize = this.renderer.size;
    // 覆盖层左上角为原点的设备像素坐标。
    const px = Math.floor((point.x / this.cssSide) * glSize);
    const py = Math.floor((point.y / this.cssSide) * glSize);
    const clampedX = clampInt(px, 0, glSize - 1);
    const clampedY = clampInt(py, 0, glSize - 1);

    // 单点读色：放大镜面板右下角显示的就是这一个像素。
    const sample = this.renderer.readPixel(clampedX, glSize - 1 - clampedY);

    const readout = this.loupe.draw(
      { x: point.x, y: point.y, cssSize: this.cssSide, glSize, dpr: this.dpr },
      sample,
      // 坐标读数用 GL 行序（原点左下），和 readPixel 的入参一致。
      { x: clampedX, y: glSize - 1 - clampedY },
      (x, y, w, h) => this.renderer.readBlock(x, y, w, h),
    );
    if (readout) {
      this.readouts.hex = readout.hex;
      this.readouts.coord = readout.coord;
    }
  }

  private updateFps(rafTime: number): void {
    const frames = this.frameTimes;
    frames.push(rafTime);
    while (frames.length > 2 && rafTime - (frames[0] ?? rafTime) > 500) frames.shift();
    if (frames.length >= 2) {
      const span = rafTime - (frames[0] ?? rafTime);
      if (span > 0) this.fps = ((frames.length - 1) * 1000) / span;
    }
  }

  /** 高频文本每 120ms 落一次 DOM，避免每帧布局。 */
  private paintReadouts(rafTime: number): void {
    this.frames++;
    if (rafTime - this.lastStatsPaint < 120) return;
    this.lastStatsPaint = rafTime;

    if (this.clockText.textContent !== this.readouts.clock) {
      this.clockText.textContent = this.readouts.clock;
    }
    const stats = this.statsLine();
    if (this.statsText.textContent !== stats) this.statsText.textContent = stats;
    const hex = this.readouts.hex;
    if (this.hexText.textContent !== hex) this.hexText.textContent = hex;
    const coord = this.readouts.coord;
    if (this.coordText.textContent !== coord) this.coordText.textContent = coord;
  }

  private statsLine(): string {
    const w = this.renderer.size;
    const fps = this.fps > 0 ? this.fps.toFixed(0) : '--';
    if (this.analytic) return `${w}×${w} · 解析覆盖 · 1 样本/像素 · ${fps} fps`;
    const n = this.samples;
    // n = 1 就是 1 点/像素，不叫超采样。
    const label = n === 1 ? '1 点/像素' : `${n}×${n} 超采样`;
    return `${w}×${w} · ${label} · ${samplesPerAxis(n)} 样本/像素 · ${fps} fps`;
  }

  /* ── 控件 ─────────────────────────────────────────────── */

  private bindControls(): void {
    for (const btn of this.analyticButtons) {
      btn.addEventListener('click', () => this.setAnalytic(btn.dataset['analytic'] === '1'));
    }
    for (const btn of this.linearButtons) {
      btn.addEventListener('click', () => this.setLinear(btn.dataset['linear'] === '1'));
    }
    for (const btn of this.tickButtons) {
      btn.addEventListener('click', () => {
        const raw = btn.dataset['tick'];
        if (raw === 'continuous' || raw === 'step') this.setTick(raw);
      });
    }
    this.samplesRange.addEventListener('input', () => {
      this.samples = clampInt(Number.parseInt(this.samplesRange.value, 10) || 1, 1, 9);
      this.syncControls();
    });
    this.fieldBtn.addEventListener('click', () => this.setField(!this.field));
    this.gridBtn.addEventListener('click', () => this.setGrid(!this.grid));
    this.loupeBtn.addEventListener('click', () => this.setLoupe(!this.loupeOn));
    this.pauseBtn.addEventListener('click', () => this.setPaused(!this.time.isPaused));
    this.resetBtn.addEventListener('click', () => {
      this.time.reset();
      this.syncControls();
    });
    this.collapseBtn.addEventListener('click', () => this.setConsoleCollapsed(true));
    this.expandBtn.addEventListener('click', () => this.setConsoleCollapsed(false));
  }

  /** 收起参数面板，把底部那一行让给表盘；右下角留一个浮标叫回来。 */
  private setConsoleCollapsed(on: boolean): void {
    if (on) {
      // 面板居中，右边缘随宽度浮动，所以“同一横坐标”只能在收起那一刻量下来。
      // 交成 CSS 变量后，点同一个位置就能来回切。
      const box = this.collapseBtn.getBoundingClientRect();
      const right = Math.round(window.innerWidth - box.right);
      document.documentElement.style.setProperty('--handle-right', `${right}px`);
    }
    this.consoleCollapsed = on;
    // 收起按钮属于面板：面板一收，它也跟着退场。
    this.consolePanel.hidden = on;
    this.collapseBtn.hidden = on;
    this.expandBtn.hidden = !on;
    this.consolePanel.closest('.app')?.classList.toggle('console-collapsed', on);
    // 表盘尺寸变了，立刻重跑一次对齐，不等 ResizeObserver 那一帧。
    this.resize();
  }

  /** 建时区选项；初值取自浏览器时区，切换即换算成固定偏移。 */
  private bindTimeZone(): void {
    this.zoneHours = initialZoneHours();
    this.applyZone();
    const select = this.timezoneSelect;
    if (!select) return;
    select.textContent = '';
    for (let h = TZ_MIN; h <= TZ_MAX; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = zoneLabel(h);
      select.append(opt);
    }
    select.value = String(this.zoneHours);
    select.addEventListener('change', () => {
      const raw = Number.parseInt(select.value, 10);
      if (Number.isFinite(raw)) {
        this.zoneHours = raw < TZ_MIN ? TZ_MIN : raw > TZ_MAX ? TZ_MAX : raw;
        this.applyZone();
      }
      this.syncControls();
    });
  }

  /** 时区只挪读数与指针的墙上时间：固定整点偏移，不跟踪夏令时。 */
  private applyZone(): void {
    this.time.setZoneShift(this.zoneHours * 3_600_000);
  }

  /** 切到解析覆盖；样本轴归 setSamples 管。 */
  private setAnalytic(on: boolean): void {
    this.analytic = on;
    this.syncControls();
  }

  /** 按每轴样本数走超采样；n = 1 即 1 点/像素。 */
  private setSamples(n: number): void {
    this.samples = clampInt(n, 1, 9);
    this.analytic = false;
    this.syncControls();
  }

  private setLinear(on: boolean): void {
    this.linear = on;
    this.syncControls();
  }

  private setTick(motion: TickMotion): void {
    this.time.setTick(motion);
    this.syncControls();
  }

  private setField(on: boolean): void {
    this.field = on;
    this.syncControls();
  }

  private setGrid(on: boolean): void {
    this.grid = on;
    this.loupe.setGrid(on);
    this.syncControls();
  }

  private setLoupe(on: boolean): void {
    this.loupeOn = on;
    this.loupePanel.hidden = !on;
    // 打开时才量得到面板的 CSS 宽度：隐藏期间 clientWidth 为 0，
    // 不重跑一次尺寸对齐的话，绘制缓冲会一直停在回退值上。
    if (on) this.resize();
    // 放大镜开着就藏光标：指针会挡住取样框，看不清对准了哪一格。
    this.dial.classList.toggle('cursor-hidden', on);
    if (!on) this.loupe.clearOverlay();
    this.syncControls();
  }

  private setPaused(on: boolean): void {
    if (on === this.time.isPaused) return;
    this.time.togglePause();
    this.syncControls();
  }

  /** 把所有控件的可见状态刷成当前值（含 aria-pressed 与 samplesGroup 的禁用）。 */
  private syncControls(): void {
    for (const btn of this.analyticButtons) {
      btn.setAttribute('aria-pressed', String((btn.dataset['analytic'] === '1') === this.analytic));
    }
    for (const btn of this.linearButtons) {
      btn.setAttribute('aria-pressed', String((btn.dataset['linear'] === '1') === this.linear));
    }
    for (const btn of this.tickButtons) {
      btn.setAttribute('aria-pressed', String(btn.dataset['tick'] === this.time.tick));
    }

    this.samplesGroup.classList.toggle('is-muted', this.analytic);
    this.samplesRange.disabled = this.analytic;
    this.samplesValue.textContent = `${this.samples}×${this.samples}`;
    this.samplesRange.value = String(this.samples);

    this.fieldBtn.setAttribute('aria-pressed', String(this.field));
    this.gridBtn.setAttribute('aria-pressed', String(this.grid));
    this.loupeBtn.setAttribute('aria-pressed', String(this.loupeOn));
    this.pauseBtn.setAttribute('aria-pressed', String(this.time.isPaused));
    if (this.timezoneSelect) this.timezoneSelect.value = String(this.zoneHours);
  }

  /* ── 指针事件 ─────────────────────────────────────────── */

  private bindPointer(): void {
    this.dial.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      this.updatePointer(ev);
      this.dragging = true;
      this.dragHand = this.pickHand(this.localPoint(ev));
      const local = this.localPoint(ev);
      this.lastAngle = pointerAngle(this.cssSide / 2, this.cssSide / 2, local.x, local.y);
      // 拖动期间冻结走时：否则针一边跑、手一边追，对不准。
      // 只记我们自己按下的这一次；你本来就暂停着的话，松手也不替你恢复。
      this.pausedByDrag = !this.time.isPaused;
      if (this.pausedByDrag) this.setPaused(true);
      this.dial.setPointerCapture(ev.pointerId);
      this.dial.classList.add('is-dragging');
      ev.preventDefault();
    });

    this.dial.addEventListener('pointermove', (ev: PointerEvent) => {
      this.updatePointer(ev);
      if (!this.dragging) return;
      const local = this.localPoint(ev);
      const angle = pointerAngle(this.cssSide / 2, this.cssSide / 2, local.x, local.y);
      const delta = wrapPi(angle - this.lastAngle);
      this.lastAngle = angle;
      // 顺时针拖 = 时间前进；整圈对应 12 小时（时针）/ 1 小时（分针）/ 1 分钟（秒针）。
      this.time.setAbsolute(
        this.time.wall(nowMs()) + (delta / TWO_PI) * CIRCLE_MS[this.dragHand],
      );
    });

    const end = (ev: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.dial.classList.remove('is-dragging');
      if (this.pausedByDrag) {
        this.pausedByDrag = false;
        this.setPaused(false);
      }
      if (this.dial.hasPointerCapture(ev.pointerId)) this.dial.releasePointerCapture(ev.pointerId);
    };
    this.dial.addEventListener('pointerup', end);
    this.dial.addEventListener('pointercancel', end);

    // 离开表盘不丢取样点：放大镜的用法就是"指住一个点、再去读放大画面"（README §4.3）。

    // 滚轮同时挂在表盘与放大镜面板上：面板现在在表盘外，盯着放大画面时也要能调。
    for (const el of [this.dial, this.loupePanel]) {
      el.addEventListener('wheel', this.onWheel, { passive: false });
    }

    this.dial.addEventListener('contextmenu', (ev: MouseEvent) => ev.preventDefault());
  }

  /**
   * 按抓取位置匹配要拨的针：角度最近者胜，越出针身长度重罚，重叠时压在上面的优先。
   * 取代了原先用 Shift 指定时针的做法。
   */
  private pickHand(local: { x: number; y: number }): DialHand {
    const half = this.cssSide / 2;
    if (!(half > 0)) return 'minute';
    // local 的原点在表盘左上角，先平移到中心再归一化；漏掉这一下角度会整体偏。
    const px = (local.x - half) / half;
    const py = -(local.y - half) / half;
    const r = Math.hypot(px, py);
    const theta = Math.atan2(px, py);
    const angles: ClockAngles = this.time.angles(nowMs());
    const spans: ReadonlyArray<readonly [DialHand, number, number]> = [
      ['hour', 0, DIAL.lHour * DIAL.fit],
      ['minute', 0, DIAL.lMin * DIAL.fit],
      ['second', -DIAL.tSec * DIAL.fit, DIAL.lSec * DIAL.fit],
    ];
    let best: DialHand = 'minute';
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [hand, rIn, rOut] of spans) {
      const dTheta = Math.abs(wrapPi(theta - angles[hand]));
      const outside = r < rIn - 0.02 || r > rOut + 0.02 ? 10 : 0;
      const zBias = hand === 'second' ? 0 : hand === 'minute' ? 0.004 : 0.008;
      const score = dTheta + outside + zBias;
      if (score < bestScore) {
        bestScore = score;
        best = hand;
      }
    }
    return best;
  }

  /** 滚轮：向上滚 = 放大（源窗口缩小一个设备像素）。倍率没有别的入口。 */
  private readonly onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const step = ev.deltaY > 0 ? 1 : -1;
    this.loupe.setSpan(this.loupe.span + step);
  };

  private updatePointer(ev: PointerEvent): void {
    const local = this.localPoint(ev);
    this.pointer = { x: local.x, y: local.y };
  }

  private localPoint(ev: PointerEvent): { x: number; y: number } {
    const rect = this.dial.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  /* ── 键盘 ─────────────────────────────────────────────── */

  private bindKeys(): void {
    window.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (isTextEntry(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      // 1–9 给每轴样本数，0 给解析覆盖：采样精度就是这一排数字。
      if (ev.key.length === 1 && ev.key >= '0' && ev.key <= '9') {
        if (ev.key === '0') this.setAnalytic(true);
        else this.setSamples(Number.parseInt(ev.key, 10));
        ev.preventDefault();
        return;
      }
      switch (ev.key) {
        case ' ':
        case 'Spacebar':
          this.setPaused(!this.time.isPaused);
          break;
        case 'g':
        case 'G':
          this.setGrid(!this.grid);
          break;
        case 'f':
        case 'F':
          this.setField(!this.field);
          break;
        case 'v':
        case 'V':
          this.setLoupe(!this.loupeOn);
          break;
        case 'r':
        case 'R':
          this.time.reset();
          this.syncControls();
          break;
        case 'h':
        case 'H':
          this.setConsoleCollapsed(!this.consoleCollapsed);
          break;
        case 't':
        case 'T':
          this.setTick(this.time.tick === 'continuous' ? 'step' : 'continuous');
          break;
        case 'b':
        case 'B':
          this.setLinear(!this.linear);
          break;
        default:
          return;
      }
      ev.preventDefault();
    });
  }
}

/* ── 工具 ───────────────────────────────────────────────── */

function sideFor(dial: HTMLElement, dpr: number): number {
  const css = dial.clientWidth > 0 ? dial.clientWidth : 512;
  const ratio = dpr > 0 ? dpr : 1;
  return clampInt(Math.round(css * ratio), MIN_SIDE, MAX_SIDE);
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  const n = Math.round(v);
  return n < lo ? lo : n > hi ? hi : n;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

boot();
