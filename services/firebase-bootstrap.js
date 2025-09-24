'use strict';

const firebaseContext = {
  status: 'idle',
  app: null,
  auth: null,
  firestore: null,
  config: null,
  error: null
};

let initializationPromise = null;

export function resolveFirebaseConfig() {
  if (firebaseContext.config) {
    return firebaseContext.config;
  }

  if (typeof window !== 'undefined' && window.__FIREBASE_CONFIG__ && typeof window.__FIREBASE_CONFIG__ === 'object') {
    firebaseContext.config = { ...window.__FIREBASE_CONFIG__ };
    return firebaseContext.config;
  }

  const meta = typeof document !== 'undefined'
    ? document.querySelector('meta[name="firebase-config"]')
    : null;

  if (meta?.content) {
    try {
      firebaseContext.config = JSON.parse(meta.content);
      return firebaseContext.config;
    } catch (error) {
      console.warn('Unable to parse firebase-config meta tag', error);
    }
  }

  return null;
}

export function getFirebaseContext() {
  return firebaseContext;
}

export async function initializeFirebaseApp() {
  if (firebaseContext.app) {
    return firebaseContext;
  }

  if (firebaseContext.status === 'initializing' && initializationPromise) {
    await initializationPromise;
    return firebaseContext;
  }

  const config = resolveFirebaseConfig();
  if (!config) {
    firebaseContext.status = 'missing-config';
    return firebaseContext;
  }

  firebaseContext.status = 'initializing';
  initializationPromise = (async () => {
    try {
      const [{ initializeApp }, { getAuth }, { getFirestore }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js'),
        import('https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js')
      ]);

      firebaseContext.app = initializeApp(config);
      firebaseContext.auth = getAuth(firebaseContext.app);
      firebaseContext.firestore = getFirestore(firebaseContext.app);
      firebaseContext.status = 'ready';
      firebaseContext.error = null;
    } catch (error) {
      firebaseContext.status = 'error';
      firebaseContext.error = error;
      console.warn('Firebase initialization failed; continuing in local-only mode.', error);
    } finally {
      initializationPromise = null;
    }
  })();

  await initializationPromise;
  return firebaseContext;
}

export function resetFirebaseContext() {
  firebaseContext.status = 'idle';
  firebaseContext.app = null;
  firebaseContext.auth = null;
  firebaseContext.firestore = null;
  firebaseContext.config = null;
  firebaseContext.error = null;
}
