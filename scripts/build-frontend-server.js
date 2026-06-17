const { execSync } = require('child_process');

const isDevBuild = process.env.PROXCHAT_DEV_BUILD === '1';
const mode = isDevBuild ? 'development' : 'production';

execSync(`npx webpack --config webpack.server.config.js --mode ${mode}`, {
  stdio: 'inherit',
  env: {
    ...process.env,
    PROXCHAT_DEV_BUILD: isDevBuild ? '1' : '0',
    WEBPACK_CLEAN: process.env.WEBPACK_CLEAN ?? '0',
  },
});
