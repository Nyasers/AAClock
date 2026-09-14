/*
 * shader.ts —— GLSL ES 3.00 源码。
 *
 * 坐标约定（README §3.1）：p = (gl_FragCoord.xy - 0.5*uRes) / (0.5*min(uRes.x,uRes.y))，
 * 原点在钟面中心，半径 1.0 即短边的一半。角度 a 从 12 点起算、顺时针为正，
 * 方向向量 vec2(sin(a), cos(a))。
 *
 * 覆盖合成铁律（README §3.3）：每一次图层叠加都写成 over(dst, src, coverage)，
 * 覆盖率即 alpha。全文件没有一处 if (d < 0.0) 直接切色——那会绕过反走样，
 * 正是这份实现要演示的反面。
 */

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

// 无属性：用 gl_VertexID 拼一个盖住整个裁剪空间的大三角形（配空 VAO）。
void main() {
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * 表盘几何（盘面空间，半径 1.0 = 画布短边一半）。
 * 着色器与 JS 的掽针命中测试共用这一份，避免两处各写一套长度。
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

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

// ── uniform 清单（README §3.7）─────────────────────────────
uniform vec2  uRes;      // 设备像素尺寸
uniform float uPx;       // 一个设备像素在画布空间里的长度 = 2 / min(uRes.x, uRes.y)
uniform float uPxDial;   // 一个设备像素在盘面空间里的长度 = uPx / FIT
uniform vec3  uAng;      // 时 / 分 / 秒角度（弧度）
uniform int   uMode;     // 0 = 超采样（n×n 硬采样平均），1 = 解析覆盖
uniform int   uSamples;  // 超采样每轴样本数（1–9；1 即 1 点/像素）
uniform int   uField;    // 覆盖场开关
uniform int   uLinear;   // 混合空间（0 = sRGB 直混，1 = 线性光）
uniform float uGlow;     // 秒针晕影强度
uniform float uShadowAlpha; // 投影强度：--shadow 的 alpha（浅色主题 0.04~0.11，暗色 0.3+）。
uniform vec3  uBg;
uniform vec3  uCard;
uniform vec3  uEdge;
uniform vec3  uInk;
uniform vec3  uInkSoft;
uniform vec3  uMuted;
uniform vec3  uAccent;
uniform vec3  uCoral;
uniform vec3  uShadow;

out vec4 fragColor;

// ── 几何常量（README §3.4）────────────────────────────────
const float R_FACE       = ${DIAL.rFace};
const float R_BEZEL      = ${DIAL.rBezel};
const float R_TICKOUT    = ${DIAL.rTickOut};
// 刻度两档的里端半径：越小线越长；两档外端都落在 R_TICKOUT。
const float R_TICKMINUTE = ${DIAL.rTickMinute};
const float R_TICKHOUR   = ${DIAL.rTickHour};
const float L_HOUR       = ${DIAL.lHour};
const float L_MIN        = ${DIAL.lMin};
const float L_SEC        = ${DIAL.lSec};
const float T_SEC        = ${DIAL.tSec};
const float W_TICKMINUTE = ${DIAL.wTickMinute};
const float W_TICKHOUR   = ${DIAL.wTickHour};
const float N_MINUTE     = ${DIAL.nMinute}.0;
const float N_HOUR       = ${DIAL.nHour}.0;
// 盘面在画布内的缩放（DIAL.fit）：着色器整体收一圈，投影才有余地。
const float FIT       = ${DIAL.fit};
const float TAU       = 6.283185307179586;
const float GAMMA     = 2.2;

// ── SDF 图元（README §3.2）────────────────────────────────

float sdCircle(vec2 p, float r) {
  return length(p) - r;
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// iq 的稳健三分支圆台胶囊；r1 == r2 时退化为圆柱（a2 == l2 > 0，三个分支同时给出正确结果）。
float sdRoundCone(vec2 p, vec2 a, vec2 b, float r1, float r2) {
  vec2  ba = b - a;
  float l2 = dot(ba, ba);
  // a 与 b 重合时 iq 公式里的 1/l2 会炸；本文件的调用点都不会重合，
  // 这里仍然兜底，免得日后改几何常量时悄悄产出 NaN。
  if (l2 < 1e-12) return length(p - a) - max(r1, r2);
  float rr = r1 - r2;
  // |r1 - r2| > |b - a| 的退化锥会让 a2 < 0，sqrt 出 NaN；钳到 0。
  float a2 = max(l2 - rr * rr, 0.0);
  float il2 = 1.0 / l2;
  vec2  pa = p - a;
  float y = dot(pa, ba);
  float z = y - l2;
  vec2  x = pa * l2 - ba * y;
  float x2 = dot(x, x);
  float y2 = y * y * l2;
  float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(max(x2 * a2 * il2, 0.0)) + y * rr) * il2 - r1;
}

// 刻度环：转极坐标，用 mod 求最近刻度角，把角差乘半径化为弧长，
// 再在 (弧长, 半径) 平面里做 sdBox。切向半宽 wAng * r 是等角宽度——指向圆心。
float sdTick(vec2 p, float count, float rOut, float rIn, float wAng) {
  float len = length(p);
  // len → 0 时 atan(y, x) 的 0/0 未定义。几何上 sdBox 在 r → 0 处的极限是
  // (rOut + rIn) / 2 - (rOut - rIn) / 2 = rIn，且与角度无关（各刻度的极限相同），
  // 所以直接返回 rIn 既避开了奇点，又让覆盖场在圆心保持连续。
  if (len < 1e-5) return rIn;
  // count ≤ 0 时 TAU / count 会溢出；这在几何上没有意义，直接当作"没有刻度"。
  if (count < 1.0) return len;
  float th = atan(p.y, p.x);
  float step = TAU / count;
  // 最近刻度角：thc ∈ [-step/2, step/2)。floor 对任意符号的 th 都成立。
  float thc = th - step * floor(th / step + 0.5);
  float rad = len - 0.5 * (rOut + rIn);
  return sdBox(vec2(thc * len, rad), vec2(wAng * len, 0.5 * (rOut - rIn)));
}

// ── 覆盖函数（README §3.3）────────────────────────────────

// 解析覆盖：1 像素宽的线性过渡。d 是盘面空间的像素数（已除以 uPxDial）。
float covAA(float d) {
  return clamp(0.5 - d / uPxDial, 0.0, 1.0);
}

// 单点采样：硬阈值。step(d, 0.0) 在 d <= 0 时为 1。
float covHard(float d) {
  return step(d, 0.0);
}

float covOf(float d, int m) {
  return m == 1 ? covAA(d) : covHard(d);
}

// 唯一的合成算子：覆盖率即 alpha。uLinear == 1 时在 2.2 次幂空间里插值。
vec3 over(vec3 dst, vec3 src, float cov) {
  if (uLinear == 1) {
    vec3 d = pow(max(dst, 0.0), vec3(GAMMA));
    vec3 s = pow(max(src, 0.0), vec3(GAMMA));
    return pow(max(mix(d, s, cov), 0.0), vec3(1.0 / GAMMA));
  }
  return mix(dst, src, cov);
}

vec3 layer(vec3 dst, float d, vec3 src, int m) {
  return over(dst, src, covOf(d, m));
}

// ── 图元组合 ────────────────────────────────────────────

// 秒针 = 锥形胶囊 ∪ 近针尖的细环。
float sdSecond(vec2 p, vec2 dir) {
  float cone = sdRoundCone(p, -dir * T_SEC, dir * L_SEC, 0.0085, 0.0048);
  float ring = abs(sdCircle(p - dir * (L_SEC * 0.88), 0.020)) - 0.0030;
  return min(cone, ring);
}

// 点到秒针轴线线段的距离。用线段而不是无限直线：直线会让晕影顺着针的方向
// 铺满整个画布，越出表盘。

// 轴心 = 环 ∪ 盘 ∪ 点。
float sdAxis(vec2 p) {
  float ring = abs(sdCircle(p, 0.052)) - 0.0035;
  float disc = sdCircle(p, 0.037);
  float dot0 = sdCircle(p, 0.0125);
  return min(min(ring, disc), dot0);
}

// 覆盖场用的关键图元并集（README §3.6）。
float sdKeyUnion(vec2 p, vec2 hd, vec2 md, vec2 sd) {
  float d = min(sdTick(p, N_MINUTE, R_TICKOUT, R_TICKMINUTE, W_TICKMINUTE),
                sdTick(p, N_HOUR, R_TICKOUT, R_TICKHOUR, W_TICKHOUR));
  d = min(d, sdRoundCone(p, vec2(0.0), hd * L_HOUR, 0.0285, 0.0105));
  d = min(d, sdRoundCone(p, vec2(0.0), md * L_MIN, 0.0225, 0.0085));
  d = min(d, sdSecond(p, sd));
  d = min(d, sdAxis(p));
  return d;
}

// ── 钟面图层（画家算法，从下往上，README §3.4）─────────────
// m 为覆盖模式（1 = 解析覆盖，其余 = 硬阈值）。超采样在 main 里以 m = 0 多次调用。
vec3 shade(vec2 p, int m) {
  // 先收到盘面空间：整盘在画布内缩一圈，四周才给投影留出余地。
  p /= FIT;
  vec2 hd = vec2(sin(uAng.x), cos(uAng.x));
  vec2 md = vec2(sin(uAng.y), cos(uAng.y));
  vec2 sd = vec2(sin(uAng.z), cos(uAng.z));
  float len = length(p);

  // 底色打底，免得表盘外露出未初始化的黑。
  vec3 col = uBg;

  // 1) 投影：exp 衰减，只在外侧可见，随后的表盘面把它盖住。
  float dShadow = sdCircle(p - vec2(0.0, -0.045), R_FACE);
  // 强度取主题 --shadow 的 alpha：浅色主题几乎不可见、暗色主题沉得住，不在这里硬编码常量。
  float sh = exp(-max(dShadow, 0.0) * 14.0) * uShadowAlpha;
  col = over(col, uShadow, sh);

  // 2) 表盘面：uCard → uBg 的径向渐变。
  float rN = clamp(len / R_FACE, 0.0, 1.0);
  vec3 face = mix(uCard, uBg, 0.35 + 0.45 * rN * rN);
  col = layer(col, sdCircle(p, R_FACE), face, m);

  // 3) 收边环。
  col = layer(col, abs(sdCircle(p, R_BEZEL)) - 0.0022, uEdge, m);

  // 4) 刻度两档：分针位 60 根最短，整点 12 根最长。整点标记正好落在五分位上，
  //    所以没有独立的“五分位档”——真钟就是这么画的。短档在长档处让位。
  float cHour = covOf(sdTick(p, N_HOUR, R_TICKOUT, R_TICKHOUR, W_TICKHOUR), m);
  float cMinute =
      covOf(sdTick(p, N_MINUTE, R_TICKOUT, R_TICKMINUTE, W_TICKMINUTE), m) * (1.0 - cHour);
  col = over(col, mix(uCard, uMuted, 0.6), cMinute);
  col = over(col, uInkSoft, cHour);

  // 6) 时针。
  col = layer(col, sdRoundCone(p, vec2(0.0), hd * L_HOUR, 0.0285, 0.0105), uInkSoft, m);

  // 7) 分针。
  col = layer(col, sdRoundCone(p, vec2(0.0), md * L_MIN, 0.0225, 0.0085), uInk, m);

  // 8) 秒针晕影：到针身线段（含尾程）的距离，本身是光滑 alpha，直接当覆盖率用，画在秒针之下。
  float tAxis = clamp(dot(p, sd), -T_SEC, L_SEC);
  float dAxis = length(p - sd * tAxis);
  float glow = exp(-dAxis * dAxis * 300.0) * 0.16 * uGlow;
  col = over(col, uAccent, glow);

  // 9) 秒针。
  col = layer(col, sdSecond(p, sd), uAccent, m);

  // 10) 轴心：环 → 盘 → 点。
  col = layer(col, abs(sdCircle(p, 0.052)) - 0.0035, uCard, m);
  col = layer(col, sdCircle(p, 0.037), uInk, m);
  col = layer(col, sdCircle(p, 0.0125), uAccent, m);

  return col;
}

// ── 覆盖场视图（README §3.6）──────────────────────────────
vec3 fieldColor(vec2 p) {
  p /= FIT;
  vec2 hd = vec2(sin(uAng.x), cos(uAng.x));
  vec2 md = vec2(sin(uAng.y), cos(uAng.y));
  vec2 sd = vec2(sin(uAng.z), cos(uAng.z));

  float d = sdKeyUnion(p, hd, md, sd);
  float px = d / uPxDial;
  float t = clamp(px, -6.0, 6.0);
  vec3 col = mix(uAccent, uBg, clamp(0.5 + t * (1.0 / 12.0), 0.0, 1.0));

  // 每 1 像素一条等距线：abs(fract - 0.5) 在整数像素处取 0.5。
  float iso = abs(fract(px) - 0.5);
  return mix(col, uCoral, smoothstep(0.42, 0.5, iso) * 0.55);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));

  if (uField == 1) {
    fragColor = vec4(fieldColor(uv), 1.0);
    return;
  }

  if (uMode == 1) {
    // 解析覆盖：一次取样，覆盖函数自己给出 1 像素宽的过渡。
    fragColor = vec4(shade(uv, 1), 1.0);
    return;
  }

  // 超采样：像素内 n×n 个均匀子样本，每个用硬覆盖求色再平均。
  // n = 1 时子样本落在像素中心，就是 1 点/像素——两者本来就是同一条路径。
  int n = clamp(uSamples, 1, 9);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < n; ++j) {
    for (int i = 0; i < n; ++i) {
      vec2 sub = (vec2(float(i), float(j)) + 0.5) / float(n) - 0.5;
      vec3 c = shade(uv + sub * uPx, 0);
      // 线性光：先把每个样本转线性再平均，平均完转回。
      if (uLinear == 1) c = pow(max(c, 0.0), vec3(GAMMA));
      acc += c;
    }
  }
  vec3 col = acc * (1.0 / float(n * n));
  if (uLinear == 1) col = pow(max(col, 0.0), vec3(1.0 / GAMMA));
  fragColor = vec4(col, 1.0);
}
`;
