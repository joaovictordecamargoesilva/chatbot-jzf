import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Configura um proxy para as requisições de API durante o desenvolvimento.
    // Agora inclui rotas sem o prefixo /api para compatibilidade total.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/attendants': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/requests': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ai-active': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/history': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/media': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      }
    },
  },
  build: {
    outDir: 'dist',
  }
});
