import * as os from 'os';

function formatBytes(bytes: number, decimals = 2) {
  if (!bytes) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(decimals)} ${sizes[i]}`;
}

export function getSystemHealth() {
  const mem = process.memoryUsage();

  return {
    uptime: `${process.uptime().toFixed(0)} sec`,

    memory: {
      process: {
        rss: formatBytes(mem.rss),
        heapTotal: formatBytes(mem.heapTotal),
        heapUsed: formatBytes(mem.heapUsed),
        external: formatBytes(mem.external),
      },

      system: {
        free: formatBytes(os.freemem()),
        total: formatBytes(os.totalmem()),
      },
    },

    cpu: {
      load: os.loadavg(),
      cores: os.cpus().length,
    },
  };
}
export function generateCode(prefix: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `${prefix}-${date}-${rand}`;
}
