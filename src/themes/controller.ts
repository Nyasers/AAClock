// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/*
 * controller.ts —— 主题控制器（README §5）。
 *
 * 主题定义不是本项目的数据：src/themes/ 是 Hana 主题 CSS 的逐字副本。本模块只做
 * 三件事——解析用哪一份、把它挂到 documentElement 上、把计算样式里的变量读成
 * 一份 GL palette 交给 renderer。读取只发生在应用主题的那一刻，不每帧读。
 *
 * 本页是独立网页：不监听 postMessage、不校验 window.parent、不加载宿主 theme.css。
 * 跨源 iframe 里的明暗跟随由 Chromium 的 prefers-color-scheme 继承天然达成。
 */

import type { RGBA } from '../color';
import { flatten, parseColor, relativeLuminance } from '../color';
import { THEME_IDS } from './index';

/** renderer 需要的全部颜色（README §5.3 / §3.7）。 */
export interface GlPalette {
  bg: RGBA;
  card: RGBA;
  edge: RGBA;
  ink: RGBA;
  inkSoft: RGBA;
  muted: RGBA;
  accent: RGBA;
  coral: RGBA;
  /** `--shadow` 的 rgb；`a` 是不透明度，作为投影的独立强度系数送进着色器。 */
  shadow: RGBA;
}

/** 控制器唯一需要 renderer 提供的能力，避免模块间硬依赖。 */
export interface PaletteSink {
  setPalette(palette: GlPalette): void;
}

/** themeSelect 的首项：跟随系统明暗。 */
export const AUTO_THEME = 'auto';

const STORAGE_KEY = 'aaclock:theme';
/** 自动要跟随的明暗主题：与宿主的默认搭配一致（暖纸 / 青夜）。 */
const DARK_THEME = 'midnight';
const LIGHT_THEME = 'warm-paper';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 主题显示名：与宿主 locales 的中文名一致；缺省回落到 id。 */
const THEME_LABELS: Readonly<Record<string, string>> = {
  'warm-paper': '暖纸',
  midnight: '青夜',
  'high-contrast': '素白',
  'grass-aroma': '草香',
  contemplation: '沉思',
  absolutely: 'Absolutely',
  delve: '随时准备接住你',
  'deep-think': '用户彻底怒了',
  'new-warm-paper': '新暖纸',
  'midnight-contrast': '青夜·高对比',
  coral: '珊瑚',
};

const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export class ThemeController {
  private readonly sink: PaletteSink;
  private readonly select: HTMLSelectElement | null;
  private readonly root: HTMLElement;
  /** 系统明暗查询：只建一次，change 回调复用同一个引用（README §5.2）。 */
  private readonly media: MediaQueryList;
  /** 当前是否处于"跟随系统"。 */
  private auto = true;
  /** URL 上的 ?theme= 是否已经当过初值。 */
  private urlConsumed = false;

  constructor(sink: PaletteSink, select: HTMLSelectElement | null) {
    this.sink = sink;
    this.select = select;
    this.root = document.documentElement;
    this.media = window.matchMedia(DARK_QUERY);
  }

  /** 建选项、解析并应用主题、挂上系统明暗监听。 */
  start(): void {
    this.buildOptions();
    // 一直挂着、由 auto 决定是否响应；回调里用的是上面那一个 MediaQueryList。
    this.media.addEventListener('change', this.onSystemChange);
    this.applyResolved();
  }

  /* ── 解析 ─────────────────────────────────────────────── */

  /** 系统偏好对应的主题 id。 */
  private systemTheme(): string {
    return this.media.matches ? DARK_THEME : LIGHT_THEME;
  }

  /** 优先级：URL ?theme（仅初值）> localStorage > 系统明暗（README §5.2）。 */
  private resolve(): { id: string; auto: boolean } {
    // URL 上的 ?theme= 只认一次：每次都认的话，用户在下面选了「自动」也会被它顶回去。
    if (!this.urlConsumed) {
      this.urlConsumed = true;
      const fromUrl = new URLSearchParams(window.location.search).get('theme');
      if (fromUrl === AUTO_THEME) return { id: this.systemTheme(), auto: true };
      if (fromUrl !== null && isKnown(fromUrl)) return { id: fromUrl, auto: false };
    }

    const stored = readStorage();
    if (stored === AUTO_THEME) return { id: this.systemTheme(), auto: true };
    if (stored !== null && isKnown(stored)) return { id: stored, auto: false };

    // 未知 id 一律忽略，落到系统明暗；再没有就草香。
    return { id: this.systemTheme(), auto: true };
  }

  /** 跟随系统时，系统明暗一变就重新解析（不在回调里新建 MediaQueryList）。 */
  private readonly onSystemChange = (): void => {
    if (!this.auto) return;
    this.apply(this.systemTheme());
  };

  private applyResolved(): void {
    const resolved = this.resolve();
    this.auto = resolved.auto;
    this.apply(resolved.id);
  }

  /* ── 应用 ─────────────────────────────────────────────── */

  private apply(id: string): void {
    // dataset.theme 一落，主题 CSS 的 [data-theme] 块就生效。
    this.root.dataset['theme'] = id;
    // 变量必须从"应用之后"的计算样式里读一次。
    const styles = getComputedStyle(this.root);
    const palette = this.readPalette(styles);
    // colorScheme 管原生控件与滚动条。dark 由底色亮度判定，省掉一张
    // "哪些主题是暗色"的 TS 表——主题换色，这里自动跟着变。
    this.root.style.colorScheme = relativeLuminance(palette.bg) < 0.5 ? 'dark' : 'light';
    if (this.select) this.select.value = this.auto ? AUTO_THEME : id;
    this.sink.setPalette(palette);
  }

  /** 读 README §5.3 的变量，转成 GL palette。只在应用主题时读一次。 */
  private readPalette(styles: CSSStyleDeclaration): GlPalette {
    const raw = (name: string): string => styles.getPropertyValue(name).trim();

    const bg = parseColor(raw('--bg'));
    const ink = parseColor(raw('--text'));
    const inkSoft = parseColor(raw('--text-light'), ink);
    const border = parseColor(raw('--border'), TRANSPARENT);
    const shadow = parseColor(raw('--shadow'), TRANSPARENT);

    return {
      bg,
      card: parseColor(raw('--bg-card'), bg),
      // --border 常是 rgba()：先与 --bg 合成成实色再进 GL（README §5.3）。
      edge: flatten(border, bg),
      ink,
      inkSoft,
      muted: parseColor(raw('--text-muted'), inkSoft),
      accent: parseColor(raw('--accent'), ink),
      coral: parseColor(raw('--coral'), parseColor(raw('--accent'), ink)),
      // 投影的 rgb 与 alpha 分开送：alpha 走 uShadowAlpha 这个独立强度系数。
      // 一旦在这里与底色合成，浅色主题 0.04~0.11 的强度就没了。
      shadow,
    };
  }

  /* ── themeSelect ──────────────────────────────────────── */

  private buildOptions(): void {
    if (!this.select) return;
    this.select.textContent = '';

    const auto = document.createElement('option');
    auto.value = AUTO_THEME;
    auto.textContent = '自动';
    this.select.append(auto);

    for (const id of THEME_IDS) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = THEME_LABELS[id] ?? id;
      this.select.append(opt);
    }

    this.select.addEventListener('change', this.onSelect);
  }

  private readonly onSelect = (): void => {
    const value = this.select?.value ?? AUTO_THEME;
    writeStorage(value);
    if (value === AUTO_THEME) {
      this.applyResolved();
      return;
    }
    if (isKnown(value)) {
      this.auto = false;
      this.apply(value);
    }
  };
}

/* ── 小工具 ─────────────────────────────────────────────── */

const isKnown = (id: string): boolean => THEME_IDS.includes(id);

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式 / 某些 file:// 环境下 localStorage 会直接抛：当作没存过。
    return null;
  }
}

function writeStorage(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 存不下就算了：本次切换照样生效。
  }
}
