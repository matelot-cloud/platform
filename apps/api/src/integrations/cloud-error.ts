/**
 * Turns a cloud provider's error body into one readable line: the code plus the human message, without trace /
 * correlation ids and timestamps, kept up to ~500 characters (Entra and STS hints are long and their useful part is
 * at the end — cutting at 200 used to stop at "…Check your").
 *   Entra / Google OAuth: { error, error_description }   Google APIs: { error: { code, status, message } }
 *   AWS (XML): <Code>, <Message>                          AWS JSON (ECR): { __type, message }
 *   Docker registry / ACR: { errors: [{ code, message }] }
 */
export function cloudError(body: string, max = 500): string {
  let code: string | undefined;
  let message: string | undefined;
  const text = body.trim();
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const err = j.error;
      if (typeof err === 'string') { code = err; message = str(j.error_description) ?? str(j.message); }
      else if (err && typeof err === 'object') { const e = err as Record<string, unknown>; code = str(e.status) ?? str(e.code); message = str(e.message); }
      else if (Array.isArray(j.errors) && j.errors.length) { const e = j.errors[0] as Record<string, unknown>; code = str(e.code); message = (j.errors as Record<string, unknown>[]).map((x) => str(x.message)).filter(Boolean).join('; '); }
      else { code = str(j.__type)?.replace(/^.*#/, '') ?? str(j.code); message = str(j.message) ?? str(j.Message); }
    } catch { /* not JSON after all */ }
  } else if (text.startsWith('<')) {
    code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
    message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
  }
  let out = message ? (code && !message.includes(code) ? `${code}: ${message}` : message) : code ?? text;
  out = endAtLastSentence(stripDiagnostics(out));
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40))}…`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/**
 * Removes "Trace ID: <guid>", "Correlation ID: <guid>", "Request Id: <guid>" and "Timestamp: <date time>" whole, in any
 * order. Each value is matched by its exact shape — a loose character class used to eat the "C" of the next label
 * (hex digits include C), leaving "orrelation ID: …".
 */
function stripDiagnostics(text: string): string {
  return text
    .replace(new RegExp(`\\s*\\b(?:Trace ID|Correlation ID|Request ?Id|RequestId)\\s*:\\s*${GUID}`, 'gi'), ' ')
    .replace(/\s*\bTimestamp\s*:\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*Z?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drops a dangling fragment after the last complete sentence (what is left of a label after stripping, a cut-off id).
 * A trailing URL is kept (Entra appends its documentation link), and text without any sentence end is left alone.
 */
function endAtLastSentence(text: string): string {
  const ends = [...text.matchAll(/[.!?](?=\s|$)/g)];
  if (!ends.length) return text;
  const last = ends[ends.length - 1]!.index! + 1;
  const tail = text.slice(last).trim();
  if (!tail || /^https?:\/\/\S+$/.test(tail)) return text;
  // only fragment-shaped leftovers go: a label remnant ("…ID: x", "Timestamp"), a bare id, or a few characters;
  // a real trailing clause without a full stop ("Expected audience api://…") is kept
  const fragment = /\b(?:I[Dd]|Timestamp)\s*:/.test(tail) || /^[0-9a-fA-F-]{8,}$/.test(tail) || tail.length < 12;
  return fragment ? text.slice(0, last).trim() : text;
}
