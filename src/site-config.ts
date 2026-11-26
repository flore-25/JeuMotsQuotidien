/**
 * Public site settings injected into web/index.html (dev server and build).
 * Both values are public by design (they ship to every browser); the data is protected
 * by row level security in Supabase. Never put the service_role / secret key here.
 */

const PLACEHOLDERS = {
  '%SUPABASE_URL%': 'SUPABASE_URL',
  '%SUPABASE_PUBLISHABLE_KEY%': 'SUPABASE_PUBLISHABLE_KEY',
} as const;

/** Replace the %…% placeholders with environment values (left as-is when unset). */
export function fillConfig(html: string, { required = false } = {}): string {
  let out = html;
  for (const [placeholder, name] of Object.entries(PLACEHOLDERS)) {
    const value = process.env[name]?.trim();
    if (!value) {
      if (required) throw new Error(`Missing environment variable ${name} (see README, "Hosting").`);
      continue;
    }
    if (/secret|service_role/i.test(value) || value.startsWith('sb_secret_')) {
      throw new Error(`${name} looks like a secret key: use the publishable (anon) key, never the secret one.`);
    }
    out = out.replaceAll(placeholder, value.replaceAll('"', '&quot;'));
  }
  return out;
}
