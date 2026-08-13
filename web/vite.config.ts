import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  // Absolute, NOT './'.
  //
  // Relative asset URLs resolve against the CURRENT path, so index.html served
  // at /program/job_abc asked the browser for /program/assets/index-*.js, which
  // 404s — the app never boots, and a reload lands on a blank page. That is the
  // exact thing #27 exists to make survive.
  //
  // It only worked before because every route was one level deep. The site is
  // served from the domain root (server.js serves web/dist at /), so '/' is
  // correct at any depth.
  base: '/',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
