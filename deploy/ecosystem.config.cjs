/* global module, __dirname */
// PM2 process file. Run from the repo root: pm2 start deploy/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'bazaar',
      script: 'dist/index.js',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      env_file: '.env',
      env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '8787' },
      max_memory_restart: '300M',
      time: true,
    },
  ],
};
