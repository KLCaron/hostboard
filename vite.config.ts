import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/client',
    // Preserve Vite 7's browser baseline when upgrading the build tool.
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
  },
  server: { proxy: { '/api': 'http://127.0.0.1:3001', '/auth': 'http://127.0.0.1:3001' } },
});
