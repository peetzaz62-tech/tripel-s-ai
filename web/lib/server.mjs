// Server-side helpers shared by the API routes. Never import from client code.
import { createClient } from '@supabase/supabase-js';

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server env vars are not set');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Resolves the signed-in user from an Authorization: Bearer <access_token> header.
export async function requireUser(req, sb) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return { error: 'Not signed in', status: 401 };
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return { error: 'Invalid or expired session', status: 401 };
  return { user: data.user };
}

export const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
export const int = (v, d = 0) => (Number.isFinite(parseInt(v)) ? parseInt(v) : d);
