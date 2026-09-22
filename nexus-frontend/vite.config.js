import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Perf: lazy-chunk stylesheets (fx-*, panel-*) are NOT needed for first
// paint, but rolldown emits them as render-blocking <link rel="stylesheet">
// in index.html. Rewrite them to non-blocking loads (preload + media="print"
// swap, with no-JS fallback) so only the entry index-*.css stays critical.
// This is the build-time equivalent of the hand-written pattern for fonts.
function nonCriticalCss() {
  return {
    name: 'non-critical-css',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(
        /<link rel="stylesheet"([^>]*href="\/assets\/(?:fx-|panel-)[^"]*\.css"[^>]*)>/g,
        (_, attrs) =>
          `<link rel="preload"${attrs} as="style">` +
          `<link rel="stylesheet"${attrs} media="print" onload="this.media='all'">` +
          `<noscript><link rel="stylesheet"${attrs}></noscript>`
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), nonCriticalCss()],
  build: {
    // Perf: keep CSS split per async chunk so the initial stylesheet
    // stays small; hashed names allow immutable long-term caching.
    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
    // Perf: don't inline large assets as base64 into the JS bundle.
    assetsInlineLimit: 4096,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Perf: break the 727KB single `index-*.js` bundle into
        // independently-cacheable chunks. OGL (WebGL `setSize`/`render`),
        // motion (BlurText), markdown and supabase no longer block FCP —
        // they load on demand via React.lazy dynamic imports below.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) {
              return 'vendor-react'
            }
            if (id.includes('react-markdown') || id.includes('/mdast') || id.includes('/micromark') || id.includes('/remark') || id.includes('/rehype') || id.includes('/hast') || id.includes('/unist') || id.includes('/vfile')) {
              return 'vendor-markdown'
            }
            if (id.includes('/motion/') || id.includes('/framer-motion/') || id.includes('/motion-dom/') || id.includes('/motion-utils/')) {
              return 'vendor-motion'
            }
            if (id.includes('/ogl/')) {
              return 'vendor-ogl'
            }
            if (id.includes('/@supabase/')) {
              return 'vendor-supabase'
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons'
            }
            return 'vendor'
          }
          // Keep the heavy WebGL / animation / panel routes in their own
          // chunks so dynamic import() actually splits them.
          if (id.includes('/src/SideRays')) return 'fx-rays'
          if (id.includes('/src/BlurText')) return 'fx-blur'
          if (id.includes('/src/BorderGlow')) return 'fx-glow'
          if (id.includes('/src/HistoryPanel')) return 'panel-history'
          if (id.includes('/src/AuthPage') || id.includes('/src/AuthModal')) return 'panel-auth'
        },
      },
    },
  },
})
