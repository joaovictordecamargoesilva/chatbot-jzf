import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Configura um proxy para as requisições de API durante o desenvolvimento.
    // Todas as requisições para '/api' serão redirecionadas para o backend Express.
    proxy: {
      '/api': {
        target: 'http://localhost:3000', // URL do seu servidor backend
        changeOrigin: true, // Necessário para hosts virtuais
      },
    },
  },
  build: {
    // O diretório de saída para os arquivos de build (padrão é 'dist')
    outDir: 'dist',
  }
});
