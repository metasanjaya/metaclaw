module.exports = {
  apps: [{
    name: 'metaclaw-main',
    script: 'src/gramjs/index.js',
    cwd: '/root/metaclaw-main',
    node_args: '--experimental-vm-modules',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
