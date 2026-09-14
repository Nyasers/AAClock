// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/*
 * themes/index.ts —— Hana 主题 CSS 的 barrel（README §5）。
 *
 * 主题定义不是本项目的数据：这个目录里的 *.css 是 Hana 渲染器 themes/ 的逐字副本。
 * 本模块只做两件事：
 *   1. 以副作用方式把全部主题 CSS 装进页面（Vite 会抽成 CSS 产物并注入 <link>）；
 *   2. 从文件名导出主题 id 列表——id 不写死在 TS 里，拷进来一个文件就多一个选项。
 */

const modules = import.meta.glob('./*.css', { eager: true });

/** continuous-corners.css 是圆角几何支援（--corner-radius-scale），不是配色主题。 */
const GEOMETRY_ONLY = 'continuous-corners';

/** themeSelect 里列出的主题 id，取自 themes/*.css 的文件名（= [data-theme] 的取值）。 */
export const THEME_IDS: readonly string[] = Object.keys(modules)
  .map((path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.css$/, ''))
  .filter((id) => id !== GEOMETRY_ONLY)
  .sort();
