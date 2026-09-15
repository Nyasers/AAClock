// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/*
 * renderer.ts —— WebGL2 上下文 / 程序 / uniform / 绘制 / 读像素。
 *
 * 只负责 GL 这一侧：尺寸由 main.ts 决定，调色板由 themes/controller.ts 送来。
 * 编译或链接失败一律抛 ShaderError，由 main.ts 显示到 #fatal，绝不静默。
 */

import type { RGBA } from '../color';
import type { GlPalette } from '../themes/controller';
import VERTEX_SHADER from './fullscreen.vert?raw';
import FRAGMENT_SHADER from './dial.frag?raw';
import { DIAL } from "./DIAL";

/** 一帧要写进去的全部 uniform。 */
export interface FrameParams {
  /** true = 解析覆盖；false = n×n 硬采样平均（n = 1 即 1 点/像素）。 */
  analytic: boolean;
  /** 超采样每轴样本数（1–9）。 */
  samples: number;
  field: boolean;
  linear: boolean;
  /** 秒针晕影强度：连续走时 1，跳秒 0。 */
  glow: number;
  /** 时 / 分 / 秒角度（弧度）。 */
  angles: readonly [number, number, number];
}

/** 初始化期的一切可读失败原因（WebGL2 不可用、编译失败、链接失败）。 */
export class ShaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShaderError';
  }
}

interface UniformLocs {
  res: WebGLUniformLocation | null;
  px: WebGLUniformLocation | null;
  pxDial: WebGLUniformLocation | null;
  ang: WebGLUniformLocation | null;
  mode: WebGLUniformLocation | null;
  samples: WebGLUniformLocation | null;
  field: WebGLUniformLocation | null;
  linear: WebGLUniformLocation | null;
  glow: WebGLUniformLocation | null;
  bg: WebGLUniformLocation | null;
  card: WebGLUniformLocation | null;
  edge: WebGLUniformLocation | null;
  ink: WebGLUniformLocation | null;
  inkSoft: WebGLUniformLocation | null;
  muted: WebGLUniformLocation | null;
  accent: WebGLUniformLocation | null;
  coral: WebGLUniformLocation | null;
  shadow: WebGLUniformLocation | null;
  shadowAlpha: WebGLUniformLocation | null;
}

/** 把 infoLog 里的 "0:123" 行号对应回源码，方便在 #fatal 里直接定位。 */
function annotate(source: string, infoLog: string): string {
  const lines = source.split('\n');
  const cited = new Set<number>();
  for (const m of infoLog.matchAll(/0:(\d+)/g)) {
    const n = Number.parseInt(m[1] ?? '', 10);
    if (Number.isFinite(n)) cited.add(n);
  }
  if (cited.size === 0) return infoLog.trim();
  const parts: string[] = [infoLog.trim()];
  for (const n of [...cited].sort((a, b) => a - b)) {
    const text = lines[n - 1];
    if (text !== undefined) parts.push(`  ${n} | ${text.trim()}`);
  }
  return parts.join('\n');
}

export class ClockRenderer {
  readonly gl: WebGL2RenderingContext;

  private readonly canvas: HTMLCanvasElement;
  private pixelSize: number;
  private readonly program: WebGLProgram;
  private readonly locs: UniformLocs;
  private readonly pixel = new Uint8Array(4);
  private cachedPixel = -1;
  private disposed = false;
  /** 调色板由 controller 在 start() 时送来；没送到之前不画，避免第一帧全黑。 */
  private hasPalette = false;

  constructor(canvas: HTMLCanvasElement, size: number) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      throw new ShaderError(
        '无法获取 WebGL2 上下文。浏览器可能不支持 WebGL2，或硬件加速被禁用。',
      );
    }
    this.gl = gl;
    this.canvas = canvas;
    this.pixelSize = size;

    canvas.width = size;
    canvas.height = size;
    gl.viewport(0, 0, size, size);
    // 片元着色器自己算覆盖，不要 GL 的 MSAA 与 sRGB 转换来"帮忙"。
    gl.disable(gl.DITHER);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    const vs = ClockRenderer.compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER, '顶点着色器');
    const fs = ClockRenderer.compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER, '片元着色器');
    this.program = ClockRenderer.link(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    // 顶点着色器只用 gl_VertexID，绑一个空 VAO 即可。
    gl.bindVertexArray(null);
    this.locs = ClockRenderer.locate(gl, this.program);
  }

  /** 画布的设备像素边长（正方形，见 README §7.1）。 */
  get size(): number {
    return this.pixelSize;
  }

  /** 布局或 DPR 变化后重设绘制缓冲尺寸；上下文与程序都保留。 */
  resize(size: number): void {
    if (size === this.pixelSize || this.lost) return;
    this.pixelSize = size;
    this.canvas.width = size;
    this.canvas.height = size;
    this.gl.viewport(0, 0, size, size);
    this.cachedPixel = -1;
  }

  /** WebGL 上下文是否还活着。 */
  get lost(): boolean {
    return this.disposed || this.gl.isContextLost();
  }

  setPalette(p: GlPalette): void {
    const gl = this.gl;
    if (this.lost) return;
    gl.useProgram(this.program);
    ClockRenderer.rgb(gl, this.locs.bg, p.bg);
    ClockRenderer.rgb(gl, this.locs.card, p.card);
    ClockRenderer.rgb(gl, this.locs.edge, p.edge);
    ClockRenderer.rgb(gl, this.locs.ink, p.ink);
    ClockRenderer.rgb(gl, this.locs.inkSoft, p.inkSoft);
    ClockRenderer.rgb(gl, this.locs.muted, p.muted);
    ClockRenderer.rgb(gl, this.locs.accent, p.accent);
    ClockRenderer.rgb(gl, this.locs.coral, p.coral);
    ClockRenderer.rgb(gl, this.locs.shadow, p.shadow);
    // 投影的 alpha 不并入颜色，而是作为独立强度系数——浅色主题 0.04~0.11
    // 一旦与底色合成，投影像就没了（README §5.3）。
    if (this.locs.shadowAlpha !== null) gl.uniform1f(this.locs.shadowAlpha, p.shadow.a);
    this.hasPalette = true;
  }

  /** 画一帧。调用方保证尺寸已是当前值。 */
  draw(params: FrameParams): void {
    if (this.lost || !this.hasPalette) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.viewport(0, 0, this.size, this.size);
    gl.bindVertexArray(null);

    const px = 2 / this.size;
    gl.uniform2f(this.locs.res, this.size, this.size);
    gl.uniform1f(this.locs.px, px);
    // 盘面空间的像素长度：着色器在里面整体缩了一圈（DIAL.fit）。
    gl.uniform1f(this.locs.pxDial, px / DIAL.fit);
    gl.uniform3f(this.locs.ang, params.angles[0], params.angles[1], params.angles[2]);
    gl.uniform1i(this.locs.mode, params.analytic ? 1 : 0);
    gl.uniform1i(this.locs.samples, params.samples);
    gl.uniform1i(this.locs.field, params.field ? 1 : 0);
    gl.uniform1i(this.locs.linear, params.linear ? 1 : 0);
    gl.uniform1f(this.locs.glow, params.glow);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();
    this.cachedPixel = -1;
  }

  /**
   * 读一个设备像素，坐标原点在左下（与 gl_FragCoord 同向）。
   * 越界或上下文丢失返回 null。
   */
  readPixel(x: number, y: number): RGBA | null {
    if (this.lost) return null;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.size || iy >= this.size) return null;
    const key = iy * this.size + ix;
    const gl = this.gl;
    if (key !== this.cachedPixel) {
      gl.readPixels(ix, iy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
      this.cachedPixel = key;
    }
    return {
      r: this.pixel[0] / 255,
      g: this.pixel[1] / 255,
      b: this.pixel[2] / 255,
      a: this.pixel[3] / 255,
    };
  }

  /** 读一块像素（GL 行序，原点左下）。越界部分留 0。 */
  readBlock(x: number, y: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    if (this.lost || w <= 0 || h <= 0) return out;
    const gl = this.gl;
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteProgram(this.program);
  }

  /* ── 构建期辅助 ───────────────────────────────────────── */

  private static rgb(gl: WebGL2RenderingContext, at: WebGLUniformLocation | null, c: RGBA): void {
    if (at === null) return;
    gl.uniform3f(at, c.r, c.g, c.b);
  }

  private static compile(
    gl: WebGL2RenderingContext,
    type: number,
    source: string,
    label: string,
  ): WebGLShader {
    const sh = gl.createShader(type);
    if (sh === null) throw new ShaderError(`${label}：createShader 返回 null。`);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) {
      const log = gl.getShaderInfoLog(sh) ?? '(空的 infoLog)';
      gl.deleteShader(sh);
      throw new ShaderError(`${label}编译失败：\n${annotate(source, log)}`);
    }
    return sh;
  }

  private static link(
    gl: WebGL2RenderingContext,
    vs: WebGLShader,
    fs: WebGLShader,
  ): WebGLProgram {
    const prog = gl.createProgram();
    if (prog === null) throw new ShaderError('createProgram 返回 null。');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (gl.getProgramParameter(prog, gl.LINK_STATUS) !== true) {
      const log = gl.getProgramInfoLog(prog) ?? '(空的 infoLog)';
      gl.deleteProgram(prog);
      throw new ShaderError(`着色器链接失败：\n${log.trim()}`);
    }
    return prog;
  }

  private static locate(gl: WebGL2RenderingContext, program: WebGLProgram): UniformLocs {
    const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
    return {
      res: at('uRes'),
      px: at('uPx'),
      pxDial: at('uPxDial'),
      ang: at('uAng'),
      mode: at('uMode'),
      samples: at('uSamples'),
      field: at('uField'),
      linear: at('uLinear'),
      glow: at('uGlow'),
      bg: at('uBg'),
      card: at('uCard'),
      edge: at('uEdge'),
      ink: at('uInk'),
      inkSoft: at('uInkSoft'),
      muted: at('uMuted'),
      accent: at('uAccent'),
      coral: at('uCoral'),
      shadow: at('uShadow'),
      shadowAlpha: at('uShadowAlpha'),
    };
  }
}
