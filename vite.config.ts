import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const configuredBasePath = process.env.VITE_BASE_PATH?.trim();
const base = configuredBasePath
  ? `${configuredBasePath.replace(/\/+$/, '')}/`
  : '/';

export default defineConfig({
  plugins: [react()],
  base,
  server: {
    port: 8787,
    strictPort: true,
    // The Express server owns all backend code and secrets. Vite's dev
    // middleware must not make those source directories addressable from a
    // browser, even when a user guesses a direct URL such as /server/ai.ts.
    fs: {
      deny: [
        '**/.env*',
        '**/.git*',
        'server/**',
        'dist-server/**',
        'shared/**',
        'supabase/**',
        'scripts/**',
        'quality/**',
      ],
    },
  },
});
