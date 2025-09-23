'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 4000;
const API_BASE_URL = 'https://api.twitterapi.io';

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
});
