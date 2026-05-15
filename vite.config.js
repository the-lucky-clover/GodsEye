import { defineConfig } from 'vite'
import cesium from 'vite-plugin-cesium'
import { rm } from 'fs/promises'
import path from 'path'

// Must match the "cesium" package version in package.json.
// Bump this string whenever the cesium dependency is upgraded.
const CESIUM_VERSION = '1.139'
const CESIUM_CDN = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium`

export default defineConfig(({ command }) => ({
  plugins: [
    // vite-plugin-cesium: marks cesium as an external global, injects
    // <script src> / <link href> tags, and copies Cesium static assets into dist/.
    cesium(),

    // Production only: redirect Cesium assets to the public CDN so the dist/
    // directory stays small for Cloudflare Pages free-tier deployment.
    // vite-plugin-cesium still copies assets locally in closeBundle(); this
    // companion plugin rewrites the injected HTML tags and then deletes the copy.
    command === 'build' && {
      name: 'cesium-cdn-redirect',
      enforce: 'post',

      // Rewrite the <script src> and <link href> injected by vite-plugin-cesium
      // to point at the CDN rather than the local /cesium/ sub-path.
      transformIndexHtml(html) {
        return html
          .replace('/cesium/Cesium.js', `${CESIUM_CDN}/Cesium.js`)
          .replace('/cesium/Widgets/widgets.css', `${CESIUM_CDN}/Widgets/widgets.css`)
      },

      // After vite-plugin-cesium finishes copying the Cesium asset tree,
      // remove it — Workers, Assets, Widgets and ThirdParty are all served
      // by the CDN; no local copy is needed inside the Pages deployment.
      async closeBundle() {
        await rm(path.resolve('dist', 'cesium'), { recursive: true, force: true })
        console.log('[cesium-cdn-redirect] Removed dist/cesium — assets served from CDN')
      },
    },
  ].filter(Boolean),

  server: { port: 3000 },
}))
