import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// WxtVitest 提供 fake-browser（内存版 browser.* API）、自动导入与路径别名
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // DOM 相关单测（engine/scanner）运行在 jsdom 中
    environment: 'jsdom',
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
