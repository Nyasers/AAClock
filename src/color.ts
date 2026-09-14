/*
 * color.ts —— 颜色解析与混合。
 *
 * 全部颜色在内部表示为 0..1 归一化的 RGBA（sRGB 编码值，不是线性光）。
 * 需要线性光时由调用方显式 toLinear / toSrgb。
 *
 * 无依赖：只做数字运算，不接触 DOM。
 */

/** 归一化的 sRGB 颜色，分量范围 0..1，`a` 为不透明度。 */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 十六进制分量（0..255）→ 0..1。 */
const c8 = (v: number): number => clamp01(v / 255);

/** 解析 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`，失败返回 null。 */
function parseHex(src: string): RGBA | null {
  const n = src.length - 1;
  const d = src.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(d)) return null;
  let r: number;
  let g: number;
  let b: number;
  let a = 1;
  if (n === 3 || n === 4) {
    r = parseInt(d[0]! + d[0]!, 16);
    g = parseInt(d[1]! + d[1]!, 16);
    b = parseInt(d[2]! + d[2]!, 16);
    if (n === 4) a = c8(parseInt(d[3]! + d[3]!, 16));
  } else if (n === 6 || n === 8) {
    r = parseInt(d.slice(0, 2), 16);
    g = parseInt(d.slice(2, 4), 16);
    b = parseInt(d.slice(4, 6), 16);
    if (n === 8) a = c8(parseInt(d.slice(6, 8), 16));
  } else {
    return null;
  }
  return { r: c8(r), g: c8(g), b: c8(b), a };
}

/** 解析 `rgb()` / `rgba()`（逗号或空格分隔；百分比；alpha 支持 0..1 与百分比）。 */
function parseFunc(src: string): RGBA | null {
  const open = src.indexOf('(');
  const close = src.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const head = src.slice(0, open).trim().toLowerCase();
  if (head !== 'rgb' && head !== 'rgba') return null;
  const body = src.slice(open + 1, close).replace(/\//g, ' ');
  const parts = body.split(/[,\s]+/).filter((p) => p.length > 0);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const chan = (raw: string): number | null => {
    const pct = raw.endsWith('%');
    const num = Number.parseFloat(pct ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(num)) return null;
    return clamp01(pct ? num / 100 : num / 255);
  };
  const r = chan(parts[0]!);
  const g = chan(parts[1]!);
  const b = chan(parts[2]!);
  if (r === null || g === null || b === null) return null;
  let a = 1;
  if (parts.length === 4) {
    const raw = parts[3]!;
    const num = Number.parseFloat(raw.endsWith('%') ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(num)) return null;
    a = clamp01(raw.endsWith('%') ? num / 100 : num);
  }
  return { r, g, b, a };
}

/**
 * 解析颜色字符串。支持 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` /
 * `rgb()` / `rgba()`，大小写与首尾空白不敏感。无法识别时返回 `fallback`。
 */
export function parseColor(input: string, fallback: RGBA = { r: 0, g: 0, b: 0, a: 1 }): RGBA {
  const src = input.trim();
  if (src.length === 0) return { ...fallback };
  const parsed = src.startsWith('#')
    ? parseHex(src)
    : src.includes('(')
      ? parseFunc(src)
      : null;
  return parsed ?? { ...fallback };
}

/** 插值：`t = 0` 取 a，`t = 1` 取 b（含 alpha）。 */
export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  const k = clamp01(t);
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  };
}

/**
 * 源覆盖合成（source-over）：src 盖在 dst 之上。
 * 等价于 `mix(dst, src, src.a)`——本实现里"覆盖率即 alpha"，
 * 所以着色器里的每一次图层合成都是这一条。
 */
export function over(dst: RGBA, src: RGBA): RGBA {
  const a = src.a + dst.a * (1 - src.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (src.r * src.a + dst.r * dst.a * (1 - src.a)) / a,
    g: (src.g * src.a + dst.g * dst.a * (1 - src.a)) / a,
    b: (src.b * src.a + dst.b * dst.a * (1 - src.a)) / a,
    a,
  };
}

/** 把半透明色压在实底上，得到不透明结果。 */
export function flatten(src: RGBA, backdrop: RGBA): RGBA {
  const out = over(backdrop, src);
  out.a = 1;
  return out;
}

const b255 = (v: number): number => Math.round(clamp01(v) * 255);

/** → `#rrggbb`（忽略 alpha）。 */
export function toHex(c: RGBA): string {
  const h = (v: number): string => b255(v).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

/** → `rgba(r, g, b, a)`。 */
export function toCss(c: RGBA): string {
  const a = Math.round(clamp01(c.a) * 1000) / 1000;
  return `rgba(${b255(c.r)}, ${b255(c.g)}, ${b255(c.b)}, ${a})`;
}

/** → `#rrggbbaa`，用于 `toHex` 的 alpha 版本。 */
export function toHexA(c: RGBA): string {
  return toHex(c) + b255(c.a).toString(16).padStart(2, '0');
}

/** sRGB 编码值 → 线性光（与着色器里的 `pow(c, 2.2)` 保持一致）。 */
export function toLinear(c: RGBA): RGBA {
  const f = (v: number): number => Math.pow(clamp01(v), 2.2);
  return { r: f(c.r), g: f(c.g), b: f(c.b), a: c.a };
}

/** 线性光 → sRGB 编码值（与着色器里的 `pow(c, 1.0 / 2.2)` 保持一致）。 */
export function toSrgb(c: RGBA): RGBA {
  const f = (v: number): number => Math.pow(clamp01(v), 1 / 2.2);
  return { r: f(c.r), g: f(c.g), b: f(c.b), a: c.a };
}

/** WCAG 相对亮度：controller 用它从底色判断明暗，决定 colorScheme。 */
export function relativeLuminance(c: RGBA): number {
  const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(clamp01(c.r)) + 0.7152 * lin(clamp01(c.g)) + 0.0722 * lin(clamp01(c.b));
}

/** 在 accent 上写字时用的墨色：亮度高于阈值用黑，否则用白。 */
export function readableInk(c: RGBA): RGBA {
  return relativeLuminance(c) > 0.42
    ? { r: 0.09, g: 0.1, b: 0.11, a: 1 }
    : { r: 1, g: 1, b: 1, a: 1 };
}
