// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/*
 * themes/index.ts —— 主题 CSS 的入口（README §5）。
 *
 * 主题定义不是本项目的数据：这些 CSS 由 submodule 里的上游仓库提供
 * （vendor/openhanako/desktop/src/themes/，见 README §12）。本模块只做两件事：
 *   1. 以副作用方式把清单里的主题 CSS 装进页面（Vite 抽成 CSS 产物并注入 <link>）；
 *   2. 转发主题 id 清单。
 *
 * 逐个文件显式 import，不 glob 整个目录：上游那份目录里还有本项目不消费的
 * 字体样式（new-warm-paper-fonts.css）与字体文件，glob 会把它们一并装进来。
 */

import '../../vendor/openhanako/desktop/src/themes/absolutely.css';
import '../../vendor/openhanako/desktop/src/themes/contemplation.css';
import '../../vendor/openhanako/desktop/src/themes/coral.css';
import '../../vendor/openhanako/desktop/src/themes/deep-think.css';
import '../../vendor/openhanako/desktop/src/themes/delve.css';
import '../../vendor/openhanako/desktop/src/themes/grass-aroma.css';
import '../../vendor/openhanako/desktop/src/themes/high-contrast.css';
import '../../vendor/openhanako/desktop/src/themes/midnight.css';
import '../../vendor/openhanako/desktop/src/themes/midnight-contrast.css';
import '../../vendor/openhanako/desktop/src/themes/new-warm-paper.css';
import '../../vendor/openhanako/desktop/src/themes/warm-paper.css';

export { THEME_IDS } from './catalog';
