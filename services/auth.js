'use strict';

import { resolveFirebaseConfig, getFirebaseContext, initializeFirebaseApp } from './firebase-bootstrap.js';

const defaultAuthState = {
  status: 'offline-only',
  user: null,
  email: null,
  available: false,
  error: null,
  linkSentTo: null
};

const EMAIL_STORAGE_KEY = 'tweet-link-saver-auth-email';

let authStateRef = null;
const subscribers = new Set();

function notifySubscribers() {
  if (!authStateRef) return;
  subscribers.forEach((callback) => {
    try {
      callback(authStateRef);
    } catch (error) {
      console.error('Auth subscriber error', error);
    }
  });
}

export function setupAuthLayer(state) {
  if (!state.auth) {
    state.auth = { ...defaultAuthState };
  } else {
    Object.assign(state.auth, defaultAuthState);
  }

  authStateRef = state.auth;

  const config = resolveFirebaseConfig();
  authStateRef.available = !!config;

  if (!config) {
    authStateRef.status = 'offline-only';
    notifySubscribers();
    return authStateRef;
  }

  authStateRef.status = 'initializing';
  notifySubscribers();

  initializeFirebaseApp()
    .then(async (ctx) => {
      if (ctx.status !== 'ready') {
        authStateRef.status = 'offline-only';
        authStateRef.error = ctx.error || new Error('Firebase unavailable');
        notifySubscribers();
        return;
      }

      try {
        const {
          onAuthStateChanged,
          setPersistence,
          browserLocalPersistence
        } = await import('https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js');

        await setPersistence(ctx.auth, browserLocalPersistence).catch((error) => {
          console.warn('Unable to set auth persistence', error);
        });

        onAuthStateChanged(ctx.auth, (user) => {
          if (!authStateRef) return;
          if (user) {
            authStateRef.status = 'signed-in';
            authStateRef.user = {
              uid: user.uid,
              email: user.email,
              emailVerified: user.emailVerified
            };
            authStateRef.email = user.email || authStateRef.email;
            authStateRef.error = null;
          } else {
            authStateRef.status = 'signed-out';
            authStateRef.user = null;
            authStateRef.error = null;
          }
          notifySubscribers();
        });
      } catch (error) {
        authStateRef.status = 'offline-only';
        authStateRef.error = error;
        notifySubscribers();
      }
    })
    .catch((error) => {
      authStateRef.status = 'offline-only';
      authStateRef.error = error;
      notifySubscribers();
    });

  return authStateRef;
}

export function subscribeToAuthChanges(callback) {
  if (typeof callback !== 'function') {
    return () => {};
  }
  subscribers.add(callback);
  if (authStateRef) {
    try {
      callback(authStateRef);
    } catch (error) {
      console.error('Auth subscriber error', error);
    }
  }
  return () => subscribers.delete(callback);
}

export function getCurrentUser() {
  const ctx = getFirebaseContext();
  return ctx.auth?.currentUser || null;
}

export async function getIdToken(forceRefresh = false) {
  const user = getCurrentUser();
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch (error) {
    console.warn('[auth] Failed to get ID token', error);
    return null;
  }
}

export async function requestMagicLink(email) {
  if (!authStateRef) throw new Error('Auth layer not initialized.');
  const sanitized = String(email || '').trim();
  if (!sanitized) throw new Error('Please enter an email address.');

  const ctx = await initializeFirebaseApp();
  if (ctx.status !== 'ready' || !ctx.auth) {
    throw ctx.error || new Error('Sync is unavailable right now.');
  }

  try {
    const {
      sendSignInLinkToEmail,
      isSignInWithEmailLink
    } = await import('https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js');

    const url = new URL(window.location.origin);
    url.searchParams.set('autotrigger', '1');
    url.searchParams.set('authEmail', encodeURIComponent(sanitized));

    const actionCodeSettings = {
      url: url.toString(),
      handleCodeInApp: true
    };

    await sendSignInLinkToEmail(ctx.auth, sanitized, actionCodeSettings);
    localStorage.setItem(EMAIL_STORAGE_KEY, sanitized);
    authStateRef.status = 'link-sent';
    authStateRef.linkSentTo = sanitized;
    authStateRef.error = null;
    notifySubscribers();

    return { ok: true, email: sanitized, isEmailLink: isSignInWithEmailLink(ctx.auth, window.location.href) };
  } catch (error) {
    authStateRef.error = error;
    notifySubscribers();
    throw error;
  }
}

export async function completeSignInFromLink(url = window.location.href) {
  console.log('[auth] Starting completeSignInFromLink');
  if (!authStateRef?.available) {
    console.log('[auth] Auth state not available yet');
    return false;
  }

  const ctx = await initializeFirebaseApp();
  if (ctx.status !== 'ready' || !ctx.auth) {
    console.log('[auth] Firebase context not ready', ctx.status);
    return false;
  }

  const {
    isSignInWithEmailLink,
    signInWithEmailLink
  } = await import('https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js');

  console.log('[auth] Checking sign-in link', url);
  if (!isSignInWithEmailLink(ctx.auth, url)) {
    console.log('[auth] Current URL is not a sign-in link.');
    return false;
  }

  let email = localStorage.getItem(EMAIL_STORAGE_KEY);
  if (!email) {
    try {
      const parsedUrl = new URL(url);
      const embedded = parsedUrl.searchParams.get('authEmail');
      if (embedded) {
        email = decodeURIComponent(embedded);
      }
    } catch (_err) {
      // ignore
    }
  }

  if (!email) {
    email = window.prompt('Enter the email address you used to request the magic link:');
    if (!email) {
      authStateRef.error = new Error('Email required to complete sign-in.');
      notifySubscribers();
      return false;
    }
    email = email.trim();
  }

  try {
    console.log('[auth] Completing sign-in for email', email);
    await signInWithEmailLink(ctx.auth, email, url);
    localStorage.removeItem(EMAIL_STORAGE_KEY);
    authStateRef.linkSentTo = null;
    authStateRef.error = null;
    authStateRef.email = email;
    notifySubscribers();
    cleanMagicLinkParams();
    return true;
  } catch (error) {
    authStateRef.error = error;
    notifySubscribers();
    return false;
  }
}

export async function signOutUser() {
  const ctx = getFirebaseContext();
  if (!ctx.auth) return;
  try {
    const { signOut } = await import('https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js');
    await signOut(ctx.auth);
  } catch (error) {
    authStateRef.error = error;
    notifySubscribers();
  }
}

function cleanMagicLinkParams() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('apiKey');
    url.searchParams.delete('oobCode');
    url.searchParams.delete('mode');
    url.searchParams.delete('lang');
    window.history.replaceState({}, document.title, url.toString());
  } catch (_error) {
    // Ignore
  }
}

export function getAuthState(state) {
  if (!state?.auth) return { ...defaultAuthState };
  return state.auth;
}
