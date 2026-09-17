// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/** vite.config.ts 里 aaclock:upstream-theme-labels 插件提供的虚拟模块（README §7）。 */
declare module 'virtual:aaclock-upstream-labels' {
  /** 主题 id → 上游 locale 里的显示名。键集与 themes/catalog.ts 的 THEME_IDS 一致。 */
  export const THEME_LABELS: Readonly<Record<string, string>>;
}
