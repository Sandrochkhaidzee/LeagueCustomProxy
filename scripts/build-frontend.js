const { execSync } = require('child_process');

const isDevBuild = process.env.PROXCHAT_DEV_BUILD === '1';
const mode = isDevBuild ? 'development' : 'production';

execSync(`npx webpack --mode ${mode}`, {
  stdio: 'inherit',
  env: { ...process.env, PROXCHAT_DEV_BUILD: isDevBuild ? '1' : '0' },
});
