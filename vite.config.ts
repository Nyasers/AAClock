// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { PurgeCSS } from 'purgecss';
import { THEME_IDS, THEME_LABEL_KEYS } from './src/themes/catalog.ts';
import upstreamLocale from './vendor/openhanako/desktop/src/locales/zh.json' with { type: 'json' };
import { minify as minifyHtml } from 'html-minifier-terser';
import tokenizeGlsl, { type GlslToken } from 'glsl-tokenizer/string';

/**
 * 独立单文件构建：把 JS 与 CSS 内联进 index.html，产物只剩一个 html。
 *
 * 走 Vite 自己的 bundle 对象（generateBundle），不读磁盘、不引依赖。
 * module 脚本里一旦出现 `</script>` 会提前关掉标签，这里统一转义。
 */
function inlineStandalone(): Plugin {
  return {
    name: 'aaclock:inline-standalone',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlKey = Object.keys(bundle).find((key) => key.endsWith('.html'));
      const htmlFile = htmlKey ? bundle[htmlKey] : undefined;
      if (!htmlFile || htmlFile.type !== 'asset') return;

      let html = String(htmlFile.source);

      html = html.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g, (match, src: string) => {
        const key = src.replace(/^\.\//, '');
        const chunk = bundle[key];
        if (!chunk || chunk.type !== 'chunk') return match;
        delete bundle[key];
        const code = chunk.code.replace(/<\/script>/g, '<\\/script>');
        return `<script type="module">\n${code}\n</script>`;
      });

      html = html.replace(
        /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
        (match, href: string) => {
          const key = href.replace(/^\.\//, '');
          const asset = bundle[key];
          if (!asset || asset.type !== 'asset') return match;
          delete bundle[key];
          return `<style>\n${String(asset.source)}\n</style>`;
        },
      );

      htmlFile.source = html;
    },
  };
}

/**
 * 着色器源码进 bundle 的路：`*.frag` / `*.vert` 一律按原文加载，
 * 导入处只写文件名，不写 `?raw`（类型见 `types/shader.d.ts`）。
 * 这里只把请求转给 Vite 自己的 raw 加载器，不读磁盘。
 */
function shaderSource(): Plugin {
  return {
    name: 'aaclock:shader-source',
    enforce: 'pre',
    async load(id) {
      if (!/\.(frag|vert)$/.test(id)) return null;
      // rolldown 把 this.load 的返回值标成 ModuleInfo，这里只取它的 code。
      // 一律原文转发：换行归一是压缩那一步的事，非压缩产物要与源文件一致。
      const loaded = await this.load({ id: `${id}?raw` });
      if (!loaded?.code) throw new Error(`[aaclock] 着色器源码没读到：${id}`);
      return { code: loaded.code, map: null };
    },
  };
}

/**
 * 产物里的换行一律写成转义：JS 压缩器会把含换行的字符串写成模板字面量，
 * 换行也就原样落进产物，文件里就多出真实换行。这里换回转义过的普通字符串。
 *
 * 只动不含 `$`、反引号与反斜杠的模板字面量：这类字面量的原文就是字面内容，
 * 换成 JSON 字符串是逐字等价的；带替换的、带转义的都不碰。
 *
 * 改写只能发生在 generateBundle——Vite 的压缩器是在那一步才把字符串变成模板字面量的。
 * 插件必须排在 inlineStandalone 前面：单文件模式要把这块代码内联进 HTML，晚一步就改不到了。
 */
function escapeNewlines(): Plugin {
  // 一次扫完整：带 `${}` 的模板也要整个吃掉，否则后面的字面量会配对错位。
  const template = /`(?:[^`\\]|\\.)*`/g;
  return {
    name: 'aaclock:escape-newlines',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        file.code = file.code.replace(template, (literal) => {
          const raw = literal.slice(1, -1);
          const plain = !raw.includes('\\') && !raw.includes('${') && raw.includes('\n');
          return plain ? JSON.stringify(raw) : literal;
        });
      }
    },
  };
}

/**
 * `?raw` 进来的着色器在 bundle 里是一段字符串，JS 压缩器不碰字符串内容，
 * 于是 GLSL 的注释与缩进会原样留在产物里。这个插件在模块进入压缩前先把字符串本身压掉。
 *
 * 只认 `.frag` / `.vert` 的 `?raw` 模块，且形态固定为 Vite 的 `export default "<源码>"`；
 * 一旦形态不符就原样放行，不猜、不读磁盘。
 */
function minifyRawShaders(): Plugin {
  return {
    name: 'aaclock:minify-raw-shaders',
    transform(code, id) {
      if (!/\.(frag|vert)\?raw$/.test(id)) return null;
      const match = /^export default (".*");?\s*$/s.exec(code);
      if (!match) return null;
      return `export default ${JSON.stringify(minifyGlsl(JSON.parse(match[1])))}`;
    },
  };
}

/**
 * GLSL 压缩：按 C 族词法处理，丢注释与空白，其余记号原字面照抄。
 * 源码里本来就挨着的记号（`<<`、`+=` 这类多字符运算符会被切成的两个）之间一个字符不插；
 * 隔着空白或注释的，只在两个字面会粘成一个新记号时才补一个空格。
 * 字面量一字不改，所以产物与源逐字等价，只是没有注释和空白。
 */
function minifyGlsl(source: string): string {
  const word = /[A-Za-z0-9_$]/;
  const opTail = /[+\-*/%<>=!&|^~.]$/;
  const opHead = /^[+\-*/%<>&|^~=!]/;
  let out = '';
  let prev: GlslToken | null = null;
  for (const token of tokenizeGlsl(source)) {
    if (token.type === 'whitespace' || token.type === 'eof' || token.type.endsWith('comment')) {
      continue;
    }
    if (token.type === 'preprocessor') {
      if (out && !out.endsWith('\n')) out += '\n';
      out += `${token.data.trim()}\n`;
      prev = null;
      continue;
    }
    if (prev && prev.position + prev.data.length !== token.position && !out.endsWith('\n')) {
      const last = out[out.length - 1] ?? '';
      const head = token.data[0] ?? '';
      if ((word.test(last) && word.test(head)) || (opTail.test(last) && opHead.test(head))) {
        out += ' ';
      }
    }
    out += token.data;
    prev = token;
  }
  return out.trim();
}

/**
 * HTML 压缩：交给 html-minifier-terser，只开折空白与去注释。
 * 内联的 script / style 不动——模块脚本是已经压过的 JS，动它就是动行为。
 */
function minifyHtmlOutput(): Plugin {
  return {
    name: 'aaclock:minify-html',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.html')) {
          file.source = await minifyHtml(String(file.source), {
            collapseWhitespace: true,
            removeComments: true,
          });
        }
      }
    },
  };
}

/**
 * 编译期裁剪未使用的 CSS。上游主题 CSS 里带着这个页面从不消费的东西——
 * `--bg-texture` 那张 44 KB 的 base64 底纹就挂在它上面。
 *
 * 「谁在用」只认产物自己：CSS 内部由 PurgeCSS 算 `var()` 引用；JS 与 HTML 里出现过的
 * 变量名一律放行（JS 用 `getComputedStyle` 按名字读变量，那些名字根本不在 CSS 里）。
 * 内容变了，文件名里的 hash 也要跟着变，所以重发一份资产再把 HTML 的引用改过去。
 */
function pruneCssOutput(): Plugin {
  return {
    name: 'aaclock:prune-css',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      const key = Object.keys(bundle).find((file) => file.endsWith('.css'));
      const css = key ? bundle[key] : undefined;
      if (!key || !css || css.type !== 'asset') return;

      // 扫 JS 与 HTML，不扫 CSS 自己——否则被扫到的变量名会把自己放行。
      const usage = Object.values(bundle)
        .filter(
          (file) =>
            file.type === 'chunk' ||
            (file.type === 'asset' && file.fileName.endsWith('.html')),
        )
        .map((file) => (file.type === 'chunk' ? file.code : String(file.source)))
        .join('\n');
      const [purged] = await new PurgeCSS().purge({
        content: [{ raw: usage, extension: 'js' }],
        css: [{ raw: String(css.source), name: key }],
        variables: true,
        keyframes: true,
        safelist: { variables: [...new Set(usage.match(/--[A-Za-z0-9_-]+/g) ?? [])] },
      });
      if (purged.css === String(css.source)) return;

      delete bundle[key];
      const name = this.getFileName(
        this.emitFile({ type: 'asset', name: 'index.css', source: purged.css }),
      );
      for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.html')) {
          file.source = String(file.source).replaceAll(key, name);
        }
      }
    },
  };
}

/**
 * 主题显示名取自上游 locale：构建期只摘出清单里那几条，整个 locale 文件不进产物。
 *
 * 名字在 submodule 里（vendor/openhanako/desktop/src/locales/zh.json 的 settings.appearance）。
 * 上游改了 key、删了条目或搬了文件，这里直接抛错中断构建——显示名不静默回落到 id。
 */
function upstreamThemeLabels(): Plugin {
  const moduleId = 'virtual:aaclock-upstream-labels';
  const resolvedId = `\0${moduleId}`;
  const appearance = upstreamLocale.settings.appearance as Record<string, string>;
  const labels: Record<string, string> = {};
  const missing: string[] = [];
  for (const id of THEME_IDS) {
    const key: string | undefined = THEME_LABEL_KEYS[id];
    const label: string | undefined = key === undefined ? undefined : appearance[key];
    if (typeof label === 'string' && label.length > 0) labels[id] = label;
    else missing.push(`${id} → appearance.${key ?? '(未登记)'}`);
  }
  if (missing.length > 0) {
    throw new Error(`[aaclock] 上游 locale 里没有这些主题名：${missing.join('、')}`);
  }
  return {
    name: 'aaclock:upstream-theme-labels',
    resolveId(id) {
      return id === moduleId ? resolvedId : null;
    },
    load(id) {
      if (id !== resolvedId) return null;
      return `export const THEME_LABELS = ${JSON.stringify(labels, null, 2)};\n`;
    },
  };
}

export default defineConfig(({ mode }) => {
  // mode 就是构建变体：默认（多文件、不压缩）/ minify / standalone / standalone-minify。
  // 开关只在这里声明一处，不依赖 CLI 与配置文件的优先级。
  const standalone = mode === 'standalone' || mode === 'standalone-minify';
  const minify = mode === 'minify' || mode === 'standalone-minify';
  return {
    // base 用相对路径：产物可以直接从 file:// 打开，也可以挂在任意子路径下。
    base: './',
    build: {
      target: 'es2022',
      assetsInlineLimit: 0,
      // 两种构建都落在 dist，且每次都清空重建：产物永远是刚构建出来的那一份，
      // 也不会留下上一版的残骸。代价是后一次构建会抹掉前一次。
      outDir: 'dist',
      emptyOutDir: true,
      // 默认不压缩：产物是拿来读的；需要压缩走 --mode minify。
      // JS 压缩器用 oxc（Vite 默认）：同一份代码上它比 terser 小，构建还快；
      // CSS 裁剪与 HTML 压缩各有一个插件，见下方 plugins。
      minify: minify && 'oxc',
      cssMinify: minify,
      // 内联之后没有可预加载的独立资源。
      modulePreload: !standalone,
    },
    // 插件顺序即执行顺序：转 raw 加载 → 裁 CSS → 换行转义 → 内联 → 压 HTML。
    plugins: [
      upstreamThemeLabels(),
      shaderSource(),
      ...(minify ? [minifyRawShaders(), pruneCssOutput()] : []),
      escapeNewlines(),
      ...(standalone ? [inlineStandalone()] : []),
      ...(minify ? [minifyHtmlOutput()] : []),
    ],
    server: {
      port: 5180,
    },
  };
});
