import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'remove-index-html',
      closeBundle() {
        // Remove the generated index.html since dashboard.html is the entry
        const htmlPath = path.resolve(__dirname, '../assets/index.html');
        if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
      },
    },
  ],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../assets'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: 'script.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'style.css';
          }
          return assetInfo.name;
        },
        manualChunks: undefined,
      },
    },
  },
});
