'use strict';

const ENDPOINTS = Object.freeze({
  VERIFY: '/api/verify',
  TWEETS: '/api/tweets'
});

const TWEET_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com'
]);

const STORAGE_KEYS = Object.freeze({
  ITEMS: 'tweet-link-saver-items',
  LEGACY: 'tweet-link-saver-links',
  API_KEY: 'tweet-link-saver-api-key'
});

const palette = Object.freeze({
  error: 'text-pink-400',
  info: 'text-amber-300',
  success: 'text-emerald-300',
  neutral: 'text-slate-300'
});

const state = {
  items: [],
  apiKey: null,
  credits: null,
  legacyQueue: [],
  isAuthenticating: false,
  isSaving: false
};

const elements = {};

function cacheElements() {
  Object.assign(elements, {
    input: document.getElementById('tweetInput'),
    saveButton: document.getElementById('saveButton'),
    form: document.getElementById('linkForm'),
    message: document.getElementById('formMessage'),
    list: document.getElementById('linkList'),
    emptyState: document.getElementById('emptyState'),
    keyStatus: document.getElementById('keyStatus'),
    keyCredits: document.getElementById('keyCredits'),
    creditsValue: document.getElementById('creditsValue'),
    changeKeyButton: document.getElementById('changeKeyButton'),
    modal: document.getElementById('apiKeyModal'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    apiKeySubmit: document.getElementById('apiKeySubmitButton'),
    apiKeyCancel: document.getElementById('apiKeyCancelButton'),
    apiKeyMessage: document.getElementById('apiKeyMessage')
  });
}

function resetMessage(target, tone = 'neutral', text = '') {
  target.textContent = text;
  target.className = target === elements.message
    ? `text-sm min-h-[1.25rem] ${palette[tone] || palette.neutral}`
    : `mt-3 text-sm min-h-[1.25rem] ${palette[tone] || palette.info}`;
}

function showMessage(text, tone = 'error') {
  resetMessage(elements.message, tone, text);
}

function showApiKeyMessage(text, tone = 'info') {
  resetMessage(elements.apiKeyMessage, tone, text);
}

function loadStoredApiKey() {
  return localStorage.getItem(STORAGE_KEYS.API_KEY) || null;
}

function persistApiKey(key) {
  localStorage.setItem(STORAGE_KEYS.API_KEY, key);
}

function removeStoredApiKey() {
  localStorage.removeItem(STORAGE_KEYS.API_KEY);
}

function loadSavedItems() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.ITEMS);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        state.items = parsed.filter((item) => item && typeof item === 'object' && item.tweetId);
      }
      return;
    }

    const legacyStored = localStorage.getItem(STORAGE_KEYS.LEGACY);
    if (legacyStored) {
      const parsedLegacy = JSON.parse(legacyStored);
      if (Array.isArray(parsedLegacy)) {
        state.legacyQueue = parsedLegacy.filter((item) => typeof item === 'string');
      }
    }
  } catch (error) {
    console.error('Failed to load saved items', error);
  }
}

function persistItems() {
  localStorage.setItem(STORAGE_KEYS.ITEMS, JSON.stringify(state.items));
}

function toggleEmptyState() {
  if (state.items.length === 0) {
    elements.emptyState.classList.remove('hidden');
  } else {
    elements.emptyState.classList.add('hidden');
  }
}

function formatDate(value) {
  if (!value) return '';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (error) {
    return '';
  }
}

function formatCount(value) {
  if (typeof value !== 'number') return '0';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function updateKeyStatus(tone = state.apiKey ? 'success' : 'info') {
  if (!state.apiKey) {
    elements.keyStatus.textContent = 'API key required to fetch tweets.';
    elements.keyStatus.className = `text-sm ${palette.info}`;
    elements.keyCredits.classList.add('hidden');
    elements.changeKeyButton.textContent = 'Enter API Key';
    return;
  }

  elements.keyStatus.textContent = 'Authenticated with twitterapi.io.';
  elements.keyStatus.className = `text-sm ${palette[tone] || palette.success}`;
  if (typeof state.credits === 'number') {
    elements.keyCredits.classList.remove('hidden');
    elements.creditsValue.textContent = state.credits.toLocaleString();
  } else {
    elements.keyCredits.classList.add('hidden');
  }
  elements.changeKeyButton.textContent = 'Change API Key';
}

function setModalVisibility(isVisible, { allowCancel = false, presetKey = '' } = {}) {
  if (isVisible) {
    elements.apiKeyInput.value = presetKey || '';
    elements.modal.classList.remove('hidden');
    elements.apiKeyCancel.classList.toggle('hidden', !allowCancel);
    showApiKeyMessage('', 'info');
    setTimeout(() => elements.apiKeyInput.focus(), 0);
    return;
  }

  elements.modal.classList.add('hidden');
  elements.apiKeyInput.value = '';
  showApiKeyMessage('', 'info');
}

function setApiKeyLoading(isLoading) {
  elements.apiKeySubmit.disabled = isLoading;
  elements.apiKeySubmit.textContent = isLoading ? 'Verifying...' : 'Save Key';
}

function setSavingState(isSaving) {
  state.isSaving = isSaving;
  elements.saveButton.textContent = isSaving ? 'Saving...' : 'Save';
}

function getTweetIdFromUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (!TWEET_HOSTS.has(url.hostname.toLowerCase())) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;

    let idCandidate = null;
    const statusIndex = segments.indexOf('status');
    if (statusIndex >= 0 && segments[statusIndex + 1]) {
      idCandidate = segments[statusIndex + 1];
    } else if (segments[0] === 'i' && segments[1] === 'web' && segments[2] === 'status' && segments[3]) {
      idCandidate = segments[3];
    }

    if (!idCandidate) return null;
    const match = idCandidate.match(/(\d{5,})/);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

function updateButtonState() {
  const value = elements.input.value.trim();
  if (state.isSaving || state.isAuthenticating || !state.apiKey) {
    elements.saveButton.disabled = true;
    return;
  }

  if (!value) {
    elements.saveButton.disabled = true;
    showMessage('', 'neutral');
    return;
  }

  const tweetId = getTweetIdFromUrl(value);
  if (tweetId) {
    elements.saveButton.disabled = false;
    showMessage('', 'neutral');
  } else {
    elements.saveButton.disabled = true;
    showMessage('Please enter a tweet link from x.com or twitter.com.');
  }
}

function renderItems() {
  elements.list.innerHTML = '';
  toggleEmptyState();

  state.items.forEach((item) => {
    const listItem = document.createElement('li');
    listItem.className = 'rounded-xl border border-slate-800 bg-slate-800/60 px-5 py-4 shadow-sm';

    const headerRow = document.createElement('div');
    headerRow.className = 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between';

    const linkWrapper = document.createElement('div');
    linkWrapper.className = 'flex flex-col gap-1';

    const anchor = document.createElement('a');
    anchor.href = item.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.className = 'truncate text-sky-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50';
    anchor.textContent = item.url;

    const metaLine = document.createElement('div');
    metaLine.className = 'text-xs text-slate-400';
    metaLine.textContent = item.tweetId ? `Tweet ID - ${item.tweetId}` : 'Saved tweet';

    linkWrapper.append(anchor, metaLine);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'self-start rounded-md border border-slate-700 px-3 py-1 text-sm text-slate-200 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => {
      state.items = state.items.filter((entry) => entry.tweetId !== item.tweetId);
      persistItems();
      renderItems();
      updateButtonState();
      elements.input.focus();
    });

    headerRow.append(linkWrapper, deleteButton);
    listItem.append(headerRow);

    if (item.tweet && item.tweet.text) {
      const textBlock = document.createElement('p');
      textBlock.className = 'mt-3 whitespace-pre-wrap text-sm text-slate-200';
      textBlock.textContent = item.tweet.text;
      listItem.append(textBlock);
    }

    if (item.tweet && item.tweet.author) {
      const authorLine = document.createElement('div');
      authorLine.className = 'mt-3 flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-slate-400';
      const name = item.tweet.author.name || 'Unknown';
      const username = item.tweet.author.userName ? `@${item.tweet.author.userName}` : '';
      authorLine.textContent = `${name}${username ? ` - ${username}` : ''}`;
      listItem.append(authorLine);
    }

    if (item.tweet) {
      const footer = document.createElement('div');
      footer.className = 'mt-3 flex flex-wrap gap-3 text-xs text-slate-400';

      const created = formatDate(item.tweet.createdAt);
      if (created) {
        const createdEl = document.createElement('span');
        createdEl.textContent = created;
        footer.appendChild(createdEl);
      }

      const metrics = [
        ['Likes', item.tweet.likeCount],
        ['Retweets', item.tweet.retweetCount],
        ['Replies', item.tweet.replyCount]
      ];

      metrics.forEach(([label, value]) => {
        if (typeof value === 'number') {
          const metricEl = document.createElement('span');
          metricEl.textContent = `${label}: ${formatCount(value)}`;
          footer.appendChild(metricEl);
        }
      });

      if (footer.children.length > 0) {
        listItem.append(footer);
      }
    }

    elements.list.append(listItem);
  });
}

async function authenticateKey(key) {
  state.isAuthenticating = true;
  updateButtonState();
  try {
    const response = await fetch(ENDPOINTS.VERIFY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ apiKey: key })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data?.message || 'Unable to verify API key.';
      throw new Error(message);
    }

    state.apiKey = key;
    state.credits = typeof data?.credits === 'number' ? data.credits : null;
    persistApiKey(key);
    updateKeyStatus('success');
    return true;
  } finally {
    state.isAuthenticating = false;
    updateButtonState();
  }
}

async function fetchTweetById(tweetId) {
  const response = await fetch(ENDPOINTS.TWEETS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ apiKey: state.apiKey, tweetId })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.message || `Unable to fetch tweet (status ${response.status}).`;
    throw new Error(message);
  }

  if (!data?.tweet) {
    throw new Error(data?.message || 'Tweet not found.');
  }

  return data.tweet;
}

async function handleLegacyImport() {
  if (!state.legacyQueue.length || !state.apiKey) return;

  const imported = [];
  for (const url of state.legacyQueue) {
    const tweetId = getTweetIdFromUrl(url);
    if (!tweetId) continue;
    try {
      const tweet = await fetchTweetById(tweetId);
      state.items.unshift({
        tweetId,
        url,
        tweet,
        savedAt: Date.now()
      });
      imported.push(url);
    } catch (error) {
      console.warn('Failed to import legacy link', url, error);
    }
  }

  if (imported.length > 0) {
    persistItems();
    renderItems();
    showMessage(`Imported ${imported.length} legacy link${imported.length > 1 ? 's' : ''}.`, 'info');
  }

  state.legacyQueue = [];
  localStorage.removeItem(STORAGE_KEYS.LEGACY);
}

function focusTweetInput() {
  if (!elements.modal.classList.contains('hidden')) return;
  setTimeout(() => elements.input.focus(), 0);
}

async function handleApiKeySubmit() {
  const key = elements.apiKeyInput.value.trim();
  if (!key) {
    showApiKeyMessage('Please enter your twitterapi.io API key.', 'error');
    return;
  }

  setApiKeyLoading(true);
  showApiKeyMessage('Verifying key...', 'info');
  try {
    await authenticateKey(key);
    showApiKeyMessage('API key verified.', 'success');
    setModalVisibility(false);
    await handleLegacyImport();
    renderItems();
    focusTweetInput();
  } catch (error) {
    showApiKeyMessage(error.message || 'Unable to verify key.', 'error');
  } finally {
    setApiKeyLoading(false);
    updateButtonState();
  }
}

async function handleSave() {
  if (state.isSaving || state.isAuthenticating) return;
  const rawValue = elements.input.value.trim();
  const tweetId = getTweetIdFromUrl(rawValue);

  if (!state.apiKey) {
    showMessage('Please connect your API key first.', 'info');
    setModalVisibility(true, { allowCancel: true, presetKey: '' });
    showApiKeyMessage('Please enter your twitterapi.io API key to continue.', 'info');
    return;
  }

  if (!tweetId) {
    showMessage('Please enter a valid tweet link from x.com or twitter.com.');
    return;
  }

  if (state.items.some((item) => item.tweetId === tweetId)) {
    showMessage('That link is already saved.', 'info');
    return;
  }

  setSavingState(true);
  updateButtonState();
  showMessage('Fetching tweet details...', 'info');

  try {
    const tweet = await fetchTweetById(tweetId);
    state.items.unshift({
      tweetId,
      url: rawValue,
      tweet,
      savedAt: Date.now()
    });
    persistItems();
    renderItems();
    elements.input.value = '';
    showMessage('Tweet saved.', 'success');
  } catch (error) {
    showMessage(error.message || 'Unable to save tweet.');
  } finally {
    setSavingState(false);
    updateButtonState();
    focusTweetInput();
  }
}

async function initialize() {
  cacheElements();
  loadSavedItems();
  renderItems();
  updateKeyStatus();
  updateButtonState();

  const storedKey = loadStoredApiKey();
  if (storedKey) {
    elements.changeKeyButton.disabled = true;
    elements.changeKeyButton.textContent = 'Verifying key...';
    showMessage('Verifying stored API key...', 'info');
    try {
      await authenticateKey(storedKey);
      await handleLegacyImport();
      renderItems();
      showMessage('API key verified.', 'success');
      focusTweetInput();
    } catch (error) {
      removeStoredApiKey();
      state.apiKey = null;
      state.credits = null;
      updateKeyStatus('info');
      showMessage(error.message || 'Stored API key failed verification.', 'error');
      setModalVisibility(true, { allowCancel: false });
      showApiKeyMessage(error.message || 'Unable to verify API key.', 'error');
    } finally {
      elements.changeKeyButton.disabled = false;
      elements.changeKeyButton.textContent = state.apiKey ? 'Change API Key' : 'Enter API Key';
      updateButtonState();
    }
  } else {
    setModalVisibility(true, { allowCancel: false });
    showApiKeyMessage('Paste your twitterapi.io API key to get started.', 'info');
  }

  wireEventHandlers();
}

function wireEventHandlers() {
  elements.apiKeySubmit.addEventListener('click', handleApiKeySubmit);
  elements.apiKeyCancel.addEventListener('click', () => {
    setModalVisibility(false);
    focusTweetInput();
  });

  elements.apiKeyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleApiKeySubmit();
    }
    if (event.key === 'Escape' && !elements.apiKeyCancel.classList.contains('hidden')) {
      event.preventDefault();
      setModalVisibility(false);
      focusTweetInput();
    }
  });

  elements.changeKeyButton.addEventListener('click', () => {
    setModalVisibility(true, { allowCancel: !!state.apiKey, presetKey: state.apiKey || '' });
  });

  elements.input.addEventListener('input', updateButtonState);
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      elements.input.value = '';
      showMessage('', 'neutral');
      updateButtonState();
    }
  });

  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    handleSave();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initialize().catch((error) => console.error('Initialization failed', error));
});
