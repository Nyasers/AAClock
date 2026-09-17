// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/*
 * catalog.ts —— 本项目消费的上游主题清单。
 *
 * 主题定义不是本项目的数据：CSS 与显示名都由 submodule 里的上游仓库提供
 * （vendor/openhanako，见 README §5 / §12）。本文件只声明消费哪些主题，
 * 以及每个主题 id 对应上游 locale 的哪个 key。
 *
 * id 是 [data-theme] 的取值，也是上游主题 CSS 的文件名（去扩展名），两处由上游决定；
 * locale key 是上游 locales/zh.json 里 appearance 区块的名称。id 与 key 不是同一套命名
 * （kebab-case 对 camelCase，且个别主题的 key 与 id 并不规则对应），因此在这里一一写明。
 */

/** 主题 id，按字典序。 */
export const THEME_IDS: readonly string[] = [
  'absolutely',
  'contemplation',
  'coral',
  'deep-think',
  'delve',
  'grass-aroma',
  'high-contrast',
  'midnight',
  'midnight-contrast',
  'new-warm-paper',
  'warm-paper',
];

/** 主题 id → 上游 locales/zh.json 的 appearance 区块里的 key。 */
export const THEME_LABEL_KEYS: Readonly<Record<string, string>> = {
  absolutely: 'absolutely',
  contemplation: 'contemplation',
  coral: 'coral',
  'deep-think': 'deepThink',
  delve: 'delve',
  'grass-aroma': 'grassAroma',
  'high-contrast': 'highContrast',
  midnight: 'midnight',
  'midnight-contrast': 'midnightContrast',
  'new-warm-paper': 'newWarmPaper',
  'warm-paper': 'warmPaper',
};
