import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          // Claim each vendor's own packages, and pin the helpers they share
          // with the entry (react/jsx-runtime, @babel/runtime) to the
          // always-loaded react chunk. Rollup otherwise pulls a manual chunk's
          // unassigned dependencies into it, so the entry statically imported
          // all of CodeMirror to get `jsx` and `_extends`.
          manualChunks(id) {
            if (!id.includes('/node_modules/')) return undefined
            if (/\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler|@babel\/runtime)\//.test(id)) return 'vendor-react'
            if (/\/node_modules\/(@codemirror|@lezer|@uiw|@replit\/codemirror-[^/]+|@marijn|style-mod|w3c-keyname|crelt)\//.test(id)) return 'vendor-codemirror'
            if (/\/node_modules\/@xterm\//.test(id)) return 'vendor-xterm'
            return undefined
          }
        }
      }
    }
  }
})
