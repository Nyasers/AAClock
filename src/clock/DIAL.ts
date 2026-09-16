/**
 * 表盘几何（盘面空间，半径 1.0 = 画布短边一半）。
 *
 * 这是 JS 侧的一份副本，供拨针命中测试使用；渲染那份是 dial.frag 里的 const。
 * 改几何要同时改两处。
 */

export const DIAL = {
  /** 整盘在画布内再收一圈：不收的话底部投影会被方框边缘切出一条硬边。 */
  fit: 0.84,
  rFace: 0.862,
  rBezel: 0.836,
  /** 刻度外端：两档共用。 */
  rTickOut: 0.786,
  /** 刻度里端半径：越小线越长。整点最长，分针位最短。 */
  rTickMinute: 0.742,
  rTickHour: 0.7,
  lHour: 0.404,
  lMin: 0.618,
  lSec: 0.706,
  tSec: 0.148,
  /** 刻度角宽（弧度）：越长越粗。 */
  wTickMinute: 0.0026,
  wTickHour: 0.0052,
  nMinute: 60,
  nHour: 12,
} as const;
