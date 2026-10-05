import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// src/renderer/index.html carries the PRODUCTION Content-Security-Policy. The
// Vite dev server needs two sources that must never ship:
//   connect-src ws:              the HMR WebSocket
//   script-src 'unsafe-inline'   the React Refresh preamble (an inline <script>)
// `serve` adds them to the served HTML only; `build` refuses to emit an
// index.html whose CSP would let the renderer reach the network (any directive
// listing a non-local source) or run inline script
// (scripts/verify-package.mjs checks the packaged copy again).
const CSP_META = /(<meta\b[^>]*?http-equiv=["']Content-Security-Policy["'][^>]*?\bcontent=")([^"]*)(")/i
const DEV_ONLY: Record<string, string[]> = {
  'script-src': ["'unsafe-inline'"],
  'connect-src': ['ws:']
}

function mapCsp(html: string, fn: (directives: Map<string, string[]>) => void): string {
  if (!CSP_META.test(html)) throw new Error('[csp] index.html has no Content-Security-Policy meta tag')
  return html.replace(CSP_META, (_m, open: string, content: string, close: string) => {
    const directives = new Map<string, string[]>()
    for (const part of content.split(';')) {
      const [name, ...values] = part.trim().split(/\s+/)
      if (name) directives.set(name.toLowerCase(), values)
    }
    fn(directives)
    return open + [...directives].map(([k, v]) => [k, ...v].join(' ')).join('; ') + close
  })
}

/** Dev server: adds the dev-only sources. Exported for tests. */
export function devCsp(html: string): string {
  return mapCsp(html, (d) => {
    for (const [dir, extra] of Object.entries(DEV_ONLY)) {
      const v = d.get(dir) ?? [...(d.get('default-src') ?? [])]
      d.set(dir, [...v, ...extra.filter((e) => !v.includes(e))])
    }
  })
}

// The only sources a production directive may list: keywords, hashes/nonces and
// schemes that never leave the machine. Anything else (http: ws: ftp: …, *, a
// host, a bare scheme like https:) reaches outside app://. Same allow-list as
// scripts/verify-package.mjs.
const LOCAL_SOURCE =
  /^('self'|'none'|'unsafe-inline'|'unsafe-eval'|'wasm-unsafe-eval'|'unsafe-hashes'|'strict-dynamic'|'report-sample'|'inline-speculation-rules'|'nonce-[^']+'|'sha(256|384|512)-[^']+'|blob:|data:|mediastream:|filesystem:|app:(\/\/renderer(\/[^\s]*)?)?)$/i
// Directives whose values are not source lists.
const NON_SOURCE_DIRECTIVES = new Set([
  'sandbox',
  'report-to',
  'trusted-types',
  'require-trusted-types-for',
  'upgrade-insecure-requests',
  'block-all-mixed-content',
  'plugin-types',
  'webrtc'
])

/** Production build: throws if the CSP allows the network, WebSockets or inline script. Exported for tests. */
export function assertProductionCsp(html: string): string {
  const problems: string[] = []
  mapCsp(html, (d) => {
    // without default-src every directive left out (object-src, frame-src, …) is unrestricted
    if (!d.has('default-src')) problems.push('no default-src (every unlisted directive would allow any origin)')
    const def = d.get('default-src') ?? []
    // EVERY directive with a source list, not a fixed subset: an explicit
    // frame-src/child-src/object-src/manifest-src https: loads remote content too
    for (const [dir, values] of d) {
      if (NON_SOURCE_DIRECTIVES.has(dir)) continue
      for (const src of values) if (!LOCAL_SOURCE.test(src)) problems.push(`${dir} ${src}`)
    }
    if ((d.get('script-src') ?? def).includes("'unsafe-inline'")) problems.push("script-src 'unsafe-inline'")
    if (d.get('script-src-elem')?.includes("'unsafe-inline'")) problems.push("script-src-elem 'unsafe-inline'")
  })
  if (problems.length) {
    throw new Error(`[csp] production index.html CSP allows: ${problems.join(', ')} — keep dev-only sources in devCsp()`)
  }
  return html
}

function cspPlugin(): Plugin[] {
  return [
    { name: 'sitsense-csp-dev', apply: 'serve', transformIndexHtml: { order: 'pre', handler: devCsp } },
    { name: 'sitsense-csp-build', apply: 'build', transformIndexHtml: { order: 'post', handler: assertProductionCsp } }
  ]
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
    plugins: [react(), tailwindcss(), cspPlugin()]
  }
})
