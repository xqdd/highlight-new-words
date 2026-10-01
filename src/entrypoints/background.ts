import { defineBackground } from 'wxt/utils/define-background';
import { setupBackground } from '@/background';

export default defineBackground({
  type: 'module',
  main() {
    setupBackground();
  },
});
