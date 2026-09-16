import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Root `/` in dev; `/drone-airspace-map/` subpath for the GitHub Pages build.
  base: process.env.GH_PAGES ? '/drone-airspace-map/' : '/',
  plugins: [react()],
})