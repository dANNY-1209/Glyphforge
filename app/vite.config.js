import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load configuration (with fallback for build time)
let config = {
  promptFolder: { name: 'prompts' },
  loraFolder: { name: 'loras' },
  galleryFolder: { name: 'gallery' }
}

try {
  const configPath = path.join(__dirname, 'config.json')
  if (fs.existsSync(configPath)) {
    const loadedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    if (loadedConfig.promptFolder?.name) config.promptFolder = loadedConfig.promptFolder
    if (loadedConfig.loraFolder?.name) config.loraFolder = loadedConfig.loraFolder
    if (loadedConfig.galleryFolder?.name) config.galleryFolder = loadedConfig.galleryFolder
  }
} catch (error) {
  console.warn('Warning: Could not load config.json, using defaults')
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: [
      'glyphforge.dh1209.com',
      'localhost',
      '.local'
    ],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      [`/${config.promptFolder.name}`]: {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      [`/${config.loraFolder.name}`]: {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      [`/${config.galleryFolder.name}`]: {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    },
    hmr: {
      overlay: false
    },
    watch: {
      usePolling: false
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true
  }
})
