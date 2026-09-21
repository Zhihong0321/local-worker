// PM2 process manager configuration
module.exports = {
  apps: [
    {
      name: 'local-worker',
      script: 'worker.mjs',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
