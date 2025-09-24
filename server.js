'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const dotenv = require('dotenv');
const admin = require('firebase-admin');

dotenv.config();
const localEnvPath = path.join(__dirname, '.env.local');
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath, override: true });
}

const app = express();
const PORT = process.env.PORT || 4000;
const API_BASE_URL = 'https://api.twitterapi.io';
const DATA_DIR = path.join(__dirname, 'data');
const KEY_STORE_FILE = path.join(DATA_DIR, 'api-keys.json');

const encryptionSecret = process.env.ENCRYPTION_SECRET || '';
const encryptionKey = encryptionSecret
  ? crypto.createHash('sha256').update(encryptionSecret).digest()
  : null;

let firebaseWebConfig = null;
try {
  if (process.env.FIREBASE_WEB_CONFIG) {
    firebaseWebConfig = JSON.parse(process.env.FIREBASE_WEB_CONFIG);
  }
} catch (error) {
    console.warn('Unable to parse FIREBASE_WEB_CONFIG environment variable.', error);
    firebaseWebConfig = null;
}

let firebaseApp = null;
let firebaseAuth = null;
let firebaseInitError = null;

initializeFirebaseAdmin();

app.use(express.json({ limit: '100kb' }));

app.use((req, _res, next) => {
  console.log('[request]', req.method, req.path);
  next();
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, X-Firebase-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

function extractApiKey(req, res) {
  const keyFromBody = req.body?.apiKey;
  const keyFromHeader = req.headers['x-api-key'];
  const key = typeof keyFromBody === 'string' && keyFromBody.trim()
    ? keyFromBody.trim()
    : typeof keyFromHeader === 'string' && keyFromHeader.trim()
      ? keyFromHeader.trim()
      : null;

  if (!key) {
    res.status(400).json({ message: 'apiKey is required' });
    return null;
  }

  return key;
}

async function forwardRequest(path, apiKey, fetchOptions = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...fetchOptions,
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
        ...fetchOptions.headers
      },
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function initializeFirebaseAdmin() {
  if (firebaseApp || firebaseInitError) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  const privateKey = privateKeyRaw ? privateKeyRaw.replace(/\\n/g, '\n') : undefined;

  if (!projectId || !clientEmail || !privateKey) {
    firebaseInitError = new Error('Missing Firebase admin credentials.');
    console.warn('[firebase] Admin credentials incomplete; sync endpoints disabled.');
    return;
  }

  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey
      })
    });
    firebaseAuth = admin.auth();
    console.log('[firebase] Admin SDK initialized.');
  } catch (error) {
    firebaseInitError = error;
    console.warn('[firebase] Failed to initialize admin SDK; sync disabled.', error);
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

let keyStoreCache = null;

function loadKeyStore() {
  if (keyStoreCache) return keyStoreCache;
  try {
    const raw = fs.readFileSync(KEY_STORE_FILE, 'utf8');
    keyStoreCache = JSON.parse(raw);
  } catch (error) {
    keyStoreCache = {};
  }
  return keyStoreCache;
}

function saveKeyStore() {
  if (!keyStoreCache) return;
  ensureDataDir();
  fs.writeFileSync(KEY_STORE_FILE, JSON.stringify(keyStoreCache, null, 2));
}

function encryptApiKey(value) {
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_SECRET is not configured on the server.');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptApiKey(payload) {
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_SECRET is not configured on the server.');
  }
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < 28) {
    throw new Error('Encrypted payload is malformed.');
  }
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

function extractAuthToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7).trim() || null;
  }
  const customHeader = req.headers['x-firebase-token'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }
  const bodyToken = req.body?.idToken || req.body?.token;
  if (typeof bodyToken === 'string' && bodyToken.trim()) {
    return bodyToken.trim();
  }
  return null;
}

async function authenticateFirebase(req, res, next) {
  if (!firebaseAuth) {
    initializeFirebaseAdmin();
  }
  if (!firebaseAuth) {
    return res.status(503).json({ message: 'Sync service is not configured.' });
  }
  const token = extractAuthToken(req);
  if (!token) {
    return res.status(401).json({ message: 'Authentication token required.' });
  }
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    req.firebaseUser = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid authentication token.' });
  }
}

app.post('/api/verify', async (req, res) => {
  const apiKey = extractApiKey(req, res);
  if (!apiKey) return;

  try {
    const { response, payload } = await forwardRequest('/oapi/my/info', apiKey);
    if (!response.ok) {
      return res.status(response.status).json({
        message: payload?.message || 'Unable to verify API key.'
      });
    }

    return res.json({
      credits: payload?.recharge_credits ?? null
    });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'twitterapi.io verification timed out.'
      : 'Unexpected error verifying API key.';
    return res.status(502).json({ message });
  }
});

app.post('/api/tweets', async (req, res) => {
  const apiKey = extractApiKey(req, res);
  if (!apiKey) return;

  const { tweetId } = req.body || {};
  if (!tweetId || typeof tweetId !== 'string') {
    return res.status(400).json({ message: 'tweetId is required.' });
  }

  const url = new URL('/twitter/tweets', API_BASE_URL);
  url.searchParams.set('tweet_ids', tweetId);

  try {
    const { response, payload } = await forwardRequest(url.pathname + url.search, apiKey);
    if (process.env.DEBUG_TWEETS === 'true') {
      const pretty = JSON.stringify(payload, null, 2);
      console.log('twitterapi.io /twitter/tweets payload:', pretty);
      try {
        fs.writeFileSync('/tmp/tweet-link-saver-tweets.json', pretty);
      } catch (err) {
        console.warn('Unable to write tweet payload log', err);
      }
    }

    if (!response.ok) {
      return res.status(response.status).json({
        message: payload?.message || 'Unable to fetch tweet.'
      });
    }

    if (!payload || payload.status !== 'success' || !Array.isArray(payload.tweets)) {
      return res.status(502).json({ message: 'Unexpected response from twitterapi.io.' });
    }

    const tweet = payload.tweets.find((entry) => entry?.id === tweetId) || payload.tweets[0] || null;
    if (!tweet) {
      return res.status(404).json({ message: 'Tweet not found.' });
    }

    return res.json({ tweet });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'twitterapi.io request timed out.'
      : 'Unexpected error fetching tweet.';
    return res.status(502).json({ message });
  }
});

app.post('/api/thread', async (req, res) => {
  const apiKey = extractApiKey(req, res);
  if (!apiKey) return;

  const { tweetId, cursor = '' } = req.body || {};
  if (!tweetId || typeof tweetId !== 'string') {
    return res.status(400).json({ message: 'tweetId is required.' });
  }

  const seenIds = new Set();
  const collectedTweets = [];
  const maxPages = 8;
  let hasNextPage = false;
  let nextCursor = typeof cursor === 'string' ? cursor : '';
  let attempts = 0;
  let rootTweetId = null;

  try {
    do {
      const url = new URL('/twitter/tweet/thread_context', API_BASE_URL);
      url.searchParams.set('tweetId', tweetId);
      if (nextCursor) {
        url.searchParams.set('cursor', nextCursor);
      }

      const { response, payload } = await forwardRequest(url.pathname + url.search, apiKey);

      if (process.env.DEBUG_TWEETS === 'true') {
        const pretty = JSON.stringify(payload, null, 2);
        console.log('twitterapi.io /twitter/tweet/thread_context payload:', pretty);
        try {
          fs.writeFileSync('/tmp/tweet-link-saver-thread.json', pretty);
        } catch (err) {
          console.warn('Unable to write thread payload log', err);
        }
      }

      if (!response.ok) {
        return res.status(response.status).json({
          message: payload?.message || 'Unable to load thread.'
        });
      }

      if (!rootTweetId) {
        rootTweetId = payload?.tweet?.id
          || payload?.original_tweet_id
          || payload?.originalTweetId
          || tweetId;
      }

      const pageTweets = Array.isArray(payload?.tweets)
        ? payload.tweets
        : Array.isArray(payload?.replies)
          ? payload.replies
          : [];

      for (const entry of pageTweets) {
        const entryId = entry?.id || entry?.tweet_id || entry?.tweetId;
        if (!entryId || seenIds.has(entryId)) continue;
        seenIds.add(entryId);
        collectedTweets.push(entry);
      }

      hasNextPage = payload?.has_next_page ?? payload?.hasNextPage ?? false;
      nextCursor = payload?.next_cursor ?? payload?.nextCursor ?? '';
      attempts += 1;
    } while (hasNextPage && nextCursor && attempts < maxPages);

    return res.json({
      tweets: collectedTweets,
      rootTweetId,
      fetchedAt: Date.now(),
      hasNextPage: hasNextPage && !!nextCursor,
      nextCursor: hasNextPage ? nextCursor : null
    });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'twitterapi.io thread request timed out.'
      : 'Unexpected error fetching thread.';
    return res.status(502).json({ message });
  }
});

app.post('/api/user/api-key', authenticateFirebase, (req, res) => {
  const incomingKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!incomingKey) {
    return res.status(400).json({ message: 'apiKey is required.' });
  }

  try {
    const encrypted = encryptApiKey(incomingKey);
    const store = loadKeyStore();
    store[req.firebaseUser.uid] = {
      value: encrypted,
      updatedAt: Date.now()
    };
    saveKeyStore();
    return res.status(204).send();
  } catch (error) {
    console.error('Failed to save API key', error);
    return res.status(500).json({ message: 'Unable to store API key securely.' });
  }
});

app.get('/api/user/api-key', authenticateFirebase, (_req, res) => {
  const userId = _req.firebaseUser?.uid;
  if (!userId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const store = loadKeyStore();
  const record = store[userId];
  if (!record || !record.value) {
    return res.json({ apiKey: null, updatedAt: null });
  }

  try {
    const apiKey = decryptApiKey(record.value);
    return res.json({ apiKey, updatedAt: record.updatedAt ?? null });
  } catch (error) {
    console.error('Failed to decrypt stored API key', error);
    return res.status(500).json({ message: 'Unable to read stored API key.' });
  }
});

app.delete('/api/user/api-key', authenticateFirebase, (req, res) => {
  const store = loadKeyStore();
  if (store[req.firebaseUser.uid]) {
    delete store[req.firebaseUser.uid];
    saveKeyStore();
  }
  return res.status(204).send();
});

app.get('/firebase-config.js', (_req, res) => {
  console.log('[config] Serving firebase config');
  res.type('application/javascript');
  if (!firebaseWebConfig) {
    return res.send('window.__FIREBASE_CONFIG__ = null;');
  }
  const payload = JSON.stringify(firebaseWebConfig);
  return res.send(`window.__FIREBASE_CONFIG__ = ${payload};`);
});

app.use(express.static(path.join(__dirname)));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
});
