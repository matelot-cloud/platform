/** Timestamps in CLI output: local time with its UTC offset ("2026-10-18 10:52+03:00", "2026-10-18 07:52Z"), never a bare UTC that reads as local. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const zone = off === 0 ? 'Z' : `${off < 0 ? '-' : '+'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${zone}`;
}
