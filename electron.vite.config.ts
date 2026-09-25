import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The CSP in index.html allows inline scripts and websockets for the dev
 * server (React refresh preamble, HMR). A packaged build needs neither, so
 * they are dropped there — failing the build if the policy can't be found.
 */
function productionCsp(): Plugin {
  return {
    name: 'sitsense:production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      let found = false
      const out = html.replace(/(http-equiv="Content-Security-Policy"\s+content=")([^"]*)"/, (_m, head: string, csp: string) => {
        found = true
        const directives = csp.split(';').map((d) => d.trim()).filter(Boolean)
        const tightened = directives.map((d) => {
          if (d.startsWith('script-src ')) return d.replace(" 'unsafe-inline'", '')
          if (d.startsWith('connect-src ')) return d.replace(' ws:', '')
          return d
        })
        return `${head}${tightened.join('; ')}"`
      })
      if (!found) throw new Error('production-csp: no Content-Security-Policy meta tag in index.html')
      return out
    }
  }
}

export default defineConfig({
  main: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss(), productionCsp()]
  }
})
