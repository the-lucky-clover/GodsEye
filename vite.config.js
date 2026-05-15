import { defineConfig } from 'vite'
import cesium from 'vite-plugin-cesium'

// Must match the "cesium" package version in package.json.
// Bump this string whenever the cesium dependency is upgraded.
const CESIUM_VERSION = '1.139'
const CESIUM_CDN = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium`

export default defineConfig(({ command }) => ({
  plugins: [
    // vite-plugin-cesium: marks cesium as an external global, injects
    // <script src> / <link href> tags, and copies Cesium static assets into dist/.
    cesium(),

    // Production only: rewrite the injected HTML tags to load Cesium from the
    // CDN instead of the local /cesium/ sub-path.  The local copy is removed
    // by the `postbuild` npm script (package.json) which runs after vite build
    // completes all its closeBundle hooks — guaranteeing the copy is done before
    // we delete it, and keeping dist/ well under Cloudflare Pages free-tier limits.
    command === 'build' && {
      name: 'cesium-cdn-redirect',
      enforce: 'post',
      transformIndexHtml(html) {
        return html
          .replace('/cesium/Cesium.js',           `${CESIUM_CDN}/Cesium.js`)
          .replace('/cesium/Widgets/widgets.css', `${CESIUM_CDN}/Widgets/widgets.css`)
      },
    },
  ].filter(Boolean),

  server: { port: 3000 },
}))
