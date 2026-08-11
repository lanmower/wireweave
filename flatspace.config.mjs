import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export default {
  outDir: 'dist',
  contentDir: 'site/content',
  theme: './site/theme.mjs',
};
