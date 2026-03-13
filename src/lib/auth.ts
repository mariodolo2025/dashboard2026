import { supabase } from './supabase';

const ALLOWED_DOMAIN = '@dolo.com.au';

export function isAllowedEmail(email: string): boolean {
  return email.toLowerCase().trim().endsWith(ALLOWED_DOMAIN);
}

export async function signIn(email: string, password: string) {
  if (!isAllowedEmail(email)) {
    return {
      error: { message: 'Solo se permiten correos @dolo.com.au' },
      data: null,
    };
  }
  return supabase.auth.signInWithPassword({ email: email.trim(), password });
}

export async function signUp(email: string, password: string) {
  if (!isAllowedEmail(email)) {
    return {
      error: { message: 'Solo se permiten correos @dolo.com.au' },
      data: null,
    };
  }
  return supabase.auth.signUp({ email: email.trim(), password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export function getSession() {
  return supabase.auth.getSession();
}

export function onAuthStateChange(callback: (event: string, session: unknown) => void) {
  return supabase.auth.onAuthStateChange(callback);
}
