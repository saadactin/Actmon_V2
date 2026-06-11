import { formatDistanceToNow, parseISO, isValid } from 'date-fns';

export const formatBytes = (bytes) => {
  if (bytes === 0 || isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const formatDuration = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

export const formatUptime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0s';
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  
  return parts.join(' ');
};

export const formatTimeAgo = (dateStr) => {
  if (!dateStr) return 'never';
  const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
  if (!isValid(date)) return 'unknown';
  
  return formatDistanceToNow(date, { addSuffix: true });
};
