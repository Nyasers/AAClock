import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

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
      minify: minify,
      cssMinify: minify,
      // 内联之后没有可预加载的独立资源。
      modulePreload: !standalone,
    },
    plugins: standalone ? [inlineStandalone()] : [],
    server: {
      port: 5180,
    },
  };
});
