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

export function relativeTime(ts) {
  if (!ts) return 'هرگز';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'همین الان';
  if (min < 60) return `${min} دقیقه پیش`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ساعت پیش`;
  const day = Math.floor(hr / 24);
  return `${day} روز پیش`;
}

export function subUsageInfo(sub) {
  const usage = sub?.usage;
  if (!usage) return null;
  const used = (usage.uploadBytes || 0) + (usage.downloadBytes || 0);
  const total = usage.totalBytes || 0;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const now = Date.now();
  const expired = usage.expireAt ? now >= usage.expireAt : false;
  const exhausted = total > 0 ? used >= total : false;
  const daysLeft = usage.expireAt ? Math.ceil((usage.expireAt - now) / 86400000) : null;
  return { used, total, pct, expired, exhausted, daysLeft };
}
