import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the repository under /<repo>/ (Task 8: repo name as base path).
const base = process.env.GITHUB_ACTIONS ? '/budget-cli/' : '/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
    outDir: 'dist',
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
