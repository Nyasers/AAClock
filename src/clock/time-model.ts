// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/*
 * time-model.ts —— 时间模型：偏移、暂停、秒针量化、三针角度。
 *
 * t = Date.now() + offset；连续模式秒值带毫秒小数，跳秒模式取整到秒
 * （跳秒用来演示时间轴上的"别名"，与空间上的锯齿是同一件事）。
 *
 * 纯计算：不碰 DOM、不自己读时钟——now 由调用方喂进来，方便对拍与测试。
 */

export type TickMotion = 'continuous' | 'step';

/** 拨动的针：整圈分别对应 12 小时 / 1 小时 / 1 分钟。 */
export type DialHand = 'hour' | 'minute' | 'second';

const TAU = Math.PI * 2;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const HALF_DAY_MS = 43_200_000;
const DAY_MS = 86_400_000;

/** 整圈对应的毫秒数。 */
export const CIRCLE_MS: Readonly<Record<DialHand, number>> = {
  hour: HALF_DAY_MS,
  minute: HOUR_MS,
  second: MINUTE_MS,
};

/** 拿不到 Date.now() 时的兜底基准（2000-01-01T00:00:00Z）。 */
const FALLBACK_BASE_MS = Date.UTC(2000, 0, 1, 0, 0, 0);

export function nowMs(): number {
  const t = Date.now();
  return Number.isFinite(t) ? t : FALLBACK_BASE_MS;
}

/** 折回 [0, TAU)，对负数也成立。 */
function wrapTau(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** 折回 [0, DAY_MS)。 */
function wrapDay(t: number): number {
  const r = t % DAY_MS;
  return r < 0 ? r + DAY_MS : r;
}

export interface ClockAngles {
  hour: number;
  minute: number;
  second: number;
}

export class TimeModel {
  /** 相对系统时钟的偏移（毫秒）：拖动累加，校准清掉。 */
  offset = 0;

  /** 时区偏移（毫秒）：只影响读数与指针角度，不进 offset。 */
  private zoneShift = 0;

  /** 设定时区偏移；DST 由调用方按当前时刻算好再喂进来。 */
  setZoneShift(ms: number): void {
    if (Number.isFinite(ms)) this.zoneShift = ms;
  }

  private paused = false;
  private motion: TickMotion = 'continuous';
  private frozenMs = 0;

  get isPaused(): boolean {
    return this.paused;
  }

  get tick(): TickMotion {
    return this.motion;
  }

  /** 切换秒针运动；暂停期间用新规则重新量化冻结时刻。 */
  setTick(motion: TickMotion): void {
    if (motion === this.motion) return;
    this.motion = motion;
    if (this.paused) this.frozenMs = this.quantize(this.frozenMs);
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.frozenMs = this.quantize(nowMs() + this.offset);
  }

  resume(): void {
    if (!this.paused) return;
    // 从冻结时刻接着走，不追平真实时间：暂停（含按住拨针）期间钟就是停着的，
    // 恢复后的显示与冻结值连续，指针不跳。要追平真实时间就按校准。
    // frozenMs 里已经含了暂停期间的拨针量，所以这里是赋值而不是累加。
    const back = this.frozenMs - nowMs();
    if (Number.isFinite(back)) this.offset = back;
    this.paused = false;
  }

  togglePause(): boolean {
    if (this.paused) this.resume();
    else this.pause();
    return this.paused;
  }

  /** 校准：偏移清零；暂停中则冻结时刻一并改到"现在"。 */
  reset(): void {
    this.offset = 0;
    if (this.paused) this.frozenMs = this.quantize(nowMs());
  }

  /**
   * 手动设定墙上时刻（拖动时用）。
   * 暂停时直接推冻结时刻，所以"冻结走时但可以直接拨"成立。
   */
  setAbsolute(wallMs: number): void {
    if (!Number.isFinite(wallMs)) return;
    const absMs = wallMs - this.zoneShift;
    if (this.paused) {
      this.frozenMs = this.quantize(absMs);
      return;
    }
    this.offset = absMs - nowMs();
  }

  /** 当前应显示的绝对时刻（毫秒，UTC 基准）。 */
  absolute(now: number): number {
    return this.paused ? this.frozenMs : now + this.offset;
  }

  /** 当前应显示的墙上时间（毫秒）：含时区偏移。指针与读数都用它。 */
  wall(now: number): number {
    return this.absolute(now) + this.zoneShift;
  }

  /** 跳秒取整到秒；连续保留毫秒小数。 */
  quantize(absMs: number): number {
    return this.motion === 'step' ? Math.floor(absMs / 1000) * 1000 : absMs;
  }

  /** 三针角度（弧度）。a = 0 指向 12 点，顺时针为正。 */
  angles(now: number): ClockAngles {
    const inDay = wrapDay(this.quantize(this.wall(now)));
    return {
      // 时针 12 小时一圈（一天两圈），分针 1 小时一圈，秒针 1 分钟一圈。
      hour: wrapTau((inDay % HALF_DAY_MS) / HALF_DAY_MS * TAU),
      minute: wrapTau((inDay % HOUR_MS) / HOUR_MS * TAU),
      second: wrapTau((inDay % MINUTE_MS) / MINUTE_MS * TAU),
    };
  }

  /** 走时读数用的时/分/秒与毫秒。 */
  clockParts(now: number): { hours: number; minutes: number; seconds: number; millis: number } {
    const inDay = wrapDay(this.quantize(this.wall(now)));
    return {
      hours: Math.floor(inDay / HOUR_MS) % 24,
      minutes: Math.floor(inDay / MINUTE_MS) % 60,
      seconds: Math.floor(inDay / 1000) % 60,
      millis: Math.floor(inDay % 1000),
    };
  }
}

/** 从表盘中心指向某点的角度，与着色器约定一致（0 = 12 点，顺时针）。 */
export function pointerAngle(cx: number, cy: number, x: number, y: number): number {
  return Math.atan2(x - cx, cy - y);
}

/** 角差折回 (-π, π]。 */
export function wrapPi(a: number): number {
  let r = ((a % TAU) + TAU) % TAU;
  if (r > Math.PI) r -= TAU;
  return r;
}

/** 走时读数：`hh:mm:ss.mmm`（12 小时制，与 12 小时表盘一致）。跳秒模式下毫秒恒为 000。 */
export function formatClock(
  parts: { hours: number; minutes: number; seconds: number; millis: number },
  motion: TickMotion,
): string {
  const p2 = (v: number): string => String(v).padStart(2, '0');
  const p3 = (v: number): string => String(v).padStart(3, '0');
  const hour12 = parts.hours % 12 === 0 ? 12 : parts.hours % 12;
  const ms = p3(motion === 'step' ? 0 : parts.millis);
  return `${p2(hour12)}:${p2(parts.minutes)}:${p2(parts.seconds)}.${ms}`;
}
