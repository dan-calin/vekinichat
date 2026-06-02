import { supabase } from './supabase.js';

/**
 * Sign up a new user with email, password, and username.
 * The username is stored in user_metadata and the DB trigger
 * will auto-create a profile row.
 */
export async function signUp(email, password, username) {
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: { username },
        },
    });
    if (error) throw error;
    return data;
}

/**
 * Sign in with email and password.
 */
export async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
    });
    if (error) throw error;
    return data;
}

/**
 * Sign out the current user.
 */
export async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
}

/**
 * Subscribe to auth state changes.
 * Callback receives (event, session).
 */
export function onAuthChange(callback) {
    return supabase.auth.onAuthStateChange(callback);
}

/**
 * Get the current session user (synchronous from cache).
 */
export async function getUser() {
    const {
        data: { user },
    } = await supabase.auth.getUser();
    return user;
}

/**
 * Fetch the profile row for the current user.
 */
export async function getProfile(userId) {
    const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
    if (error) throw error;
    return data;
}
