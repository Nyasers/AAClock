/**
 * 着色器源码按原文进 bundle：`*.frag` / `*.vert` 一律当字符串导入，
 * 导入处不再写 `?raw`（那是 Vite 的查询约定，不该出现在源码的 import 里）。
 * 类型由本目录的声明负责，加载由 vite.config.ts 的 shaderSource 插件负责。
 */
declare module '*.frag' {
  const source: string;
  export default source;
}

declare module '*.vert' {
  const source: string;
  export default source;
}
