import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/compute': {
        target: 'http://localhost:6500',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/compute/, ''),
        configure: (proxy) => {
          const key =
            process.env.VITE_COMPUTE_KEY ||
            process.env.COMPUTE_KEY ||
            process.env.RHINO_COMPUTE_KEY ||
            'shadela-local'

          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('RhinoComputeKey', key)
          })
        },
      },
    },
  },
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
  ],
})
