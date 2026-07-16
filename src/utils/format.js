const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes < 1) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : decimals)} ${UNITS[i]}`;
}

export function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}
