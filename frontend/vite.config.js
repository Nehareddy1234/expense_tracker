import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' + outDir '../docs': GitHub Pages serves the app from
// https://<user>.github.io/<repo>/ at any subpath.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../docs',
    emptyOutDir: true,
  },
})
