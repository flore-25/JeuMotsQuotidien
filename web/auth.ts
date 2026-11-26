/**
 * Supabase client and the sign-in screen (an account is required to play).
 *
 * Sign-in: Google, or email + password (sign up with email confirmation, password reset).
 * The project URL and publishable key come from <meta> tags filled in by the dev server
 * and the build (env SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY): both are public by design,
 * the data is protected by row level security (supabase/migrations/).
 */

import { createClient, type AuthError, type SupabaseClient, type User } from '@supabase/supabase-js';

const meta = (name: string): string => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? '';
const url = meta('supabase-url');
const key = meta('supabase-key');
export const configured = /^https:\/\//.test(url) && key.length > 20 && !key.startsWith('%');

export const supabase: SupabaseClient | undefined = configured ? createClient(url, key) : undefined;

type Mode = 'signin' | 'signup' | 'reset' | 'recovery';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Supabase error messages, in French for the common cases. */
function frenchError(err: AuthError | Error): string {
  const m = err.message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Courriel ou mot de passe incorrect.';
  if (m.includes('email not confirmed')) return 'Confirmez d’abord votre adresse : le lien est dans vos courriels.';
  if (m.includes('already registered')) return 'Un compte existe déjà avec cette adresse. Connectez-vous.';
  if (m.includes('password should be at least')) return 'Le mot de passe doit contenir au moins 6 caractères.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Trop de tentatives. Réessayez dans quelques minutes.';
  if (m.includes('unable to validate email') || m.includes('invalid email')) return 'Adresse courriel invalide.';
  if (m.includes('same password')) return 'Choisissez un mot de passe différent de l’ancien.';
  if (m.includes('failed to fetch') || m.includes('network')) return 'Impossible de joindre le serveur. Vérifiez votre connexion internet.';
  if (m.includes('provider is not enabled')) return 'Ce mode de connexion n’est pas encore activé.';
  return err.message;
}

// ---------- screen ----------

let mode: Mode = 'signin';

function setMode(next: Mode): void {
  mode = next;
  const titles: Record<Mode, string> = {
    signin: 'Connexion',
    signup: 'Créer un compte',
    reset: 'Mot de passe oublié',
    recovery: 'Nouveau mot de passe',
  };
  const submit: Record<Mode, string> = {
    signin: 'Se connecter',
    signup: 'Créer mon compte',
    reset: 'Envoyer le lien',
    recovery: 'Enregistrer',
  };
  $('auth-title').textContent = titles[next];
  $('auth-submit').textContent = submit[next];
  $('auth-social').hidden = next === 'reset' || next === 'recovery';
  $('auth-email-row').hidden = next === 'recovery';
  $('auth-password-row').hidden = next === 'reset';
  const pw = $<HTMLInputElement>('auth-password');
  pw.autocomplete = next === 'signin' ? 'current-password' : 'new-password';
  $('auth-password-label').textContent = next === 'recovery' ? 'Nouveau mot de passe' : 'Mot de passe';
  $('auth-forgot').hidden = next !== 'signin';
  $('auth-switch').hidden = next === 'recovery';
  $('auth-switch-text').textContent = next === 'signin' ? 'Pas encore de compte ?' : 'Déjà un compte ?';
  $('auth-switch-link').textContent = next === 'signin' ? 'Créer un compte' : 'Se connecter';
  note('');
}

function note(text: string, kind: '' | 'good' | 'bad' = ''): void {
  const el = $('auth-note');
  el.textContent = text;
  el.className = `auth-note ${kind}`;
}

function busy(on: boolean): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#auth button')) b.disabled = on;
}

async function onSubmit(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  if (!supabase) return;
  const email = $<HTMLInputElement>('auth-email').value.trim();
  const password = $<HTMLInputElement>('auth-password').value;
  const redirect = location.origin + location.pathname;
  busy(true);
  try {
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
      if (error) throw error;
      // With email confirmation on (Supabase default), there is no session yet.
      if (!data.session) note('Presque fini : cliquez sur le lien envoyé à ' + email + ' pour confirmer votre compte.', 'good');
    } else if (mode === 'reset') {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirect });
      if (error) throw error;
      note('Si un compte existe pour ' + email + ', un lien de réinitialisation vient d’être envoyé.', 'good');
    } else {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      history.replaceState(null, '', location.pathname);
      finish();
    }
  } catch (err) {
    note(frenchError(err as AuthError), 'bad');
  } finally {
    busy(false);
  }
}

async function onGoogle(): Promise<void> {
  if (!supabase) return;
  busy(true);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
  // On success the browser leaves for Google; we only get here on error.
  if (error) {
    note(frenchError(error), 'bad');
    busy(false);
  }
}

// ---------- flow ----------

let resolveUser: ((user: User) => void) | undefined;
let currentUser: User | undefined;

function show(screen: 'auth' | 'game'): void {
  $('auth').hidden = screen !== 'auth';
  $('game').hidden = screen !== 'game';
}

function finish(): void {
  if (!currentUser || !resolveUser) return;
  show('game');
  resolveUser(currentUser);
  resolveUser = undefined;
}

/** Resolves with the signed-in player, showing the sign-in screen until there is one. */
export function requireUser(): Promise<User> {
  return new Promise(async (resolve) => {
    resolveUser = resolve;
    if (!supabase) {
      show('auth');
      setMode('signin');
      busy(true);
      note('Supabase n’est pas configuré : ajoutez SUPABASE_URL et SUPABASE_PUBLISHABLE_KEY dans .env.local (voir README).', 'bad');
      return;
    }

    $<HTMLFormElement>('auth-form').addEventListener('submit', (e) => void onSubmit(e));
    $('auth-google').addEventListener('click', () => void onGoogle());
    $('auth-forgot').addEventListener('click', () => setMode('reset'));
    $('auth-switch-link').addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));

    // A password-reset link signs the player in: ask for the new password before playing.
    const recovering = /type=recovery/.test(location.hash);

    supabase.auth.onAuthStateChange((event, session) => {
      currentUser = session?.user;
      if (event === 'PASSWORD_RECOVERY') {
        show('auth');
        setMode('recovery');
      } else if (event === 'SIGNED_IN' && mode !== 'recovery') {
        // Defer: Supabase recommends not awaiting other calls inside this callback.
        setTimeout(finish, 0);
      } else if (event === 'SIGNED_OUT') {
        location.reload();
      }
    });

    const { data } = await supabase.auth.getSession();
    currentUser = data.session?.user;
    if (recovering) {
      show('auth');
      setMode('recovery');
    } else if (currentUser) {
      finish();
    } else {
      show('auth');
      setMode('signin');
    }
  });
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}
