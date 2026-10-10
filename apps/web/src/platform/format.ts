export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** ORG_ADMIN -> "org admin", CRITICAL -> "critical" */
export const humanize = (value: string) => value.toLowerCase().replace(/_/g, ' ');

export const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export const SLUG_PATTERN = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
