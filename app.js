'use strict';

const ENDPOINTS = Object.freeze({
  VERIFY: '/api/verify',
  TWEET: '/api/tweets'
});

const SUPPORTED_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com'
]);

const STORAGE_KEYS = Object.freeze({
  ITEMS: 'tweet-link-saver-items',
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
  isSaving: false,
  isAuthenticating: false,
  activeTweetId: null
};

const elements = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  attachEventHandlers();
  initialize();
});

function cacheElements() {
  Object.assign(elements, {
    form: document.getElementById('linkForm'),
    input: document.getElementById('tweetInput'),
    saveButton: document.getElementById('saveButton'),
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
    apiKeyMessage: document.getElementById('apiKeyMessage'),
    detailModal: document.getElementById('detailModal'),
    detailPlaceholder: document.getElementById('detailPlaceholder'),
    detailContainer: document.getElementById('detailContainer'),
    detailCloseButton: document.getElementById('detailCloseButton'),
    detailTitle: document.getElementById('detailTitle')
  });
}

function attachEventHandlers() {
  elements.form.addEventListener('submit', handleSave);
  elements.input.addEventListener('input', updateSaveButtonState);
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      elements.input.value = '';
      updateSaveButtonState();
      clearMessage();
    }
  });

  elements.apiKeySubmit.addEventListener('click', handleApiKeySubmit);
  elements.apiKeyCancel.addEventListener('click', () => {
    setApiKeyModal(false);
    focusTweetInput();
  });

  elements.apiKeyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleApiKeySubmit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setApiKeyModal(false);
      focusTweetInput();
    }
  });

  elements.changeKeyButton.addEventListener('click', () => {
    setApiKeyModal(true, { allowCancel: !!state.apiKey, presetKey: state.apiKey || '' });
  });

  if (elements.detailCloseButton) {
    elements.detailCloseButton.addEventListener('click', closeDetailModal);
  }

  if (elements.detailModal) {
    elements.detailModal.addEventListener('click', (event) => {
      if (event.target === elements.detailModal) {
        closeDetailModal();
      }
    });
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.detailModal.classList.contains('hidden')) {
      event.preventDefault();
      closeDetailModal();
    }
  });
}

function initialize() {
  loadStoredItems();
  renderItems();
  renderDetail();
  updateSaveButtonState();
  updateKeyStatus();

  const storedKey = loadStoredApiKey();
  if (storedKey) {
    setAuthenticating(true);
    showMessage('Verifying stored API key...', 'info');
    authenticateKey(storedKey)
      .then(() => {
        showMessage('API key verified.', 'success');
      })
      .catch((error) => {
        showMessage(error.message || 'Failed to verify stored API key.', 'error');
        removeStoredApiKey();
        state.apiKey = null;
        state.credits = null;
        updateKeyStatus();
        setApiKeyModal(true, { allowCancel: false });
      })
      .finally(() => {
        setAuthenticating(false);
        updateSaveButtonState();
      });
  } else {
    setApiKeyModal(true, { allowCancel: false });
  }
}

function loadStoredItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ITEMS);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      state.items = parsed.filter((entry) => entry && typeof entry === 'object' && entry.tweetId);
    }
  } catch (error) {
    console.error('Failed to load saved tweets', error);
  }
}

function persistItems() {
  localStorage.setItem(STORAGE_KEYS.ITEMS, JSON.stringify(state.items));
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

function updateSaveButtonState() {
  const value = elements.input.value.trim();
  const tweetId = extractTweetId(value);
  const disabled = !tweetId || !state.apiKey || state.isSaving || state.isAuthenticating;
  elements.saveButton.disabled = disabled;
  if (!tweetId && value) {
    showMessage('Please enter a valid tweet link from x.com or twitter.com.');
  } else {
    clearMessage();
  }
}

function extractTweetId(value) {
  if (!value) return null;
  try {
    let formatted = value.trim();
    if (/^([^:]+)\.com\//.test(formatted) && !formatted.startsWith('http')) {
      formatted = `https://${formatted}`;
    }
    const url = new URL(formatted);
    if (!SUPPORTED_HOSTS.has(url.hostname.toLowerCase())) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const statusIndex = segments.indexOf('status');
    const idCandidate = statusIndex >= 0 ? segments[statusIndex + 1] : segments[segments.length - 1];
    if (!idCandidate) return null;
    const match = idCandidate.match(/(\d{5,})/);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

async function handleSave(event) {
  event.preventDefault();
  if (state.isSaving || state.isAuthenticating) return;

  const rawValue = elements.input.value.trim();
  const tweetId = extractTweetId(rawValue);

  if (!state.apiKey) {
    showMessage('Please connect your API key first.', 'info');
    setApiKeyModal(true, { allowCancel: true, presetKey: state.apiKey || '' });
    return;
  }

  if (!tweetId) {
    showMessage('Please enter a valid tweet link from x.com or twitter.com.');
    return;
  }

  if (state.items.some((item) => item.tweetId === tweetId)) {
    showMessage('That tweet is already saved.', 'info');
    return;
  }

  setSavingState(true);
  updateSaveButtonState();
  showMessage('Fetching tweet details...', 'info');

  try {
    const tweet = await fetchTweet(tweetId);
    const newItem = {
      tweetId,
      url: rawValue,
      tweet,
      savedAt: Date.now()
    };
    state.items.unshift(newItem);
    state.activeTweetId = tweetId;
    persistItems();
    renderItems();
    renderDetail();
    elements.input.value = '';
    showMessage('Tweet saved.', 'success');
  } catch (error) {
    showMessage(error.message || 'Unable to save tweet.');
  } finally {
    setSavingState(false);
    updateSaveButtonState();
    focusTweetInput();
  }
}

function deleteItem(tweetId) {
  state.items = state.items.filter((entry) => entry.tweetId !== tweetId);
  persistItems();
  if (state.activeTweetId === tweetId) {
    state.activeTweetId = null;
  }
  renderItems();
  renderDetail();
  updateSaveButtonState();
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

function renderItems() {
  elements.list.innerHTML = '';
  toggleEmptyState();

  state.items.forEach((item) => {
    const listItem = document.createElement('li');

    const wrapper = document.createElement('div');
    const isActive = state.activeTweetId === item.tweetId;
    wrapper.className = [
      'flex items-center gap-4 rounded-2xl border px-5 py-4 shadow-sm transition',
      'border-slate-800 bg-slate-900/70 hover:border-sky-500/60 hover:bg-slate-900',
      isActive ? 'border-sky-500/60 bg-slate-900 ring-2 ring-sky-500/20' : ''
    ].filter(Boolean).join(' ');

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'flex flex-1 items-center gap-4 text-left focus:outline-none';
    selectButton.addEventListener('click', () => selectItem(item.tweetId));

    const avatar = createAvatarElement(item.tweet?.author, 56);

    const textColumn = document.createElement('div');
    textColumn.className = 'flex-1 overflow-hidden';

    const snippet = document.createElement('p');
    snippet.className = 'truncate text-sm font-medium text-slate-100';
    const firstLine = (item.tweet?.text || item.url || '').split(/\r?\n/)[0];
    snippet.textContent = firstLine || 'Saved tweet';

    const authorLine = document.createElement('p');
    authorLine.className = 'mt-1 flex items-center gap-2 text-xs text-slate-400';
    if (item.tweet?.author) {
      const { name, userName } = item.tweet.author;
      authorLine.textContent = [name || 'Unknown', userName ? `@${userName}` : null]
        .filter(Boolean)
        .join(' · ');
    } else {
      authorLine.textContent = 'Unknown author';
    }

    textColumn.append(snippet, authorLine);
    selectButton.append(avatar, textColumn);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'shrink-0 rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-400 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteItem(item.tweetId);
    });

    wrapper.append(selectButton, deleteButton);
    listItem.append(wrapper);
    elements.list.append(listItem);
  });
}

function createAvatarElement(author = {}, size = 48) {
  const dimension = `${size}px`;
  if (author?.profilePicture) {
    const img = document.createElement('img');
    img.src = author.profilePicture.replace('_normal', '_200x200') || author.profilePicture;
    img.alt = author?.name ? `${author.name}'s avatar` : 'Author avatar';
    img.loading = 'lazy';
    img.className = `h-[${dimension}] w-[${dimension}] rounded-full object-cover`;
    img.style.width = dimension;
    img.style.height = dimension;
    return img;
  }

  const fallback = document.createElement('div');
  fallback.className = 'flex h-12 w-12 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-slate-300';
  fallback.textContent = author?.name?.[0]?.toUpperCase() || '?';
  fallback.style.width = dimension;
  fallback.style.height = dimension;
  return fallback;
}

function selectItem(tweetId) {
  state.activeTweetId = tweetId;
  renderItems();
  renderDetail();
}

function closeDetailModal() {
  state.activeTweetId = null;
  elements.detailModal.classList.add('hidden');
  document.body.classList.remove('overflow-hidden');
  renderItems();
}

function renderDetail() {
  if (!elements.detailModal) return;

  if (!state.activeTweetId) {
    elements.detailModal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    elements.detailPlaceholder.textContent = state.items.length ? 'Select a saved tweet to read it.' : 'Save a tweet to start a collection.';
    elements.detailPlaceholder.classList.remove('hidden');
    elements.detailContainer.classList.add('hidden');
    return;
  }

  const item = state.items.find((entry) => entry.tweetId === state.activeTweetId);
  if (!item) {
    state.activeTweetId = null;
    renderDetail();
    return;
  }

  const tweet = item.tweet;
  elements.detailPlaceholder.classList.add('hidden');
  elements.detailContainer.classList.remove('hidden');
  elements.detailContainer.innerHTML = '';
  elements.detailModal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');

  if (elements.detailTitle) {
    const author = tweet?.author;
    const parts = [author?.name || 'Thread'];
    if (author?.userName) parts.push(`@${author.userName}`);
    elements.detailTitle.textContent = parts.join(' · ');
  }

  const header = document.createElement('div');
  header.className = 'flex items-start gap-3 border-b border-slate-800/60 pb-4';
  header.append(createAvatarElement(tweet?.author, 64));

  const identity = document.createElement('div');
  identity.className = 'space-y-1';

  const nameLine = document.createElement('p');
  nameLine.className = 'text-base font-semibold text-slate-100';
  nameLine.textContent = tweet?.author?.name || 'Unknown';
  identity.append(nameLine);

  if (tweet?.author?.userName) {
    const username = document.createElement('p');
    username.className = 'text-sm text-slate-400';
    username.textContent = `@${tweet.author.userName}`;
    identity.append(username);
  }

  const metaLine = document.createElement('p');
  metaLine.className = 'text-xs text-slate-500';
  metaLine.textContent = formatDate(tweet?.createdAt);
  identity.append(metaLine);

  header.append(identity);
  elements.detailContainer.append(header);

  if (tweet?.text) {
    const body = document.createElement('p');
    body.className = 'mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-100';
    body.textContent = tweet.text;
    elements.detailContainer.append(body);
  }

  const mediaItems = collectMedia(tweet);
  if (mediaItems.length > 0) {
    const mediaWrapper = document.createElement('div');
    mediaWrapper.className = 'mt-4 grid gap-4 sm:grid-cols-2';
    mediaItems.forEach((media) => {
      if (media.type === 'photo' || media.media_url_https) {
        const figure = document.createElement('figure');
        figure.className = 'overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80';

        const img = document.createElement('img');
        img.src = media.media_url_https || media.media_url;
        img.alt = media.alt_text || media.ext_alt_text || 'Tweet image';
        img.loading = 'lazy';
        img.className = 'h-full w-full object-cover';
        figure.append(img);
        mediaWrapper.append(figure);
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        const wrapper = document.createElement('div');
        wrapper.className = 'rounded-xl border border-slate-800 bg-slate-900/80 p-2';

        const video = document.createElement('video');
        video.controls = true;
        video.preload = 'metadata';
        video.className = 'h-full w-full rounded-lg';
        const src = selectVideoVariant(media);
        if (src) {
          video.src = src;
        }
        if (media.type === 'animated_gif') {
          video.loop = true;
          video.autoplay = true;
          video.muted = true;
          video.playsInline = true;
        }
        wrapper.append(video);
        mediaWrapper.append(wrapper);
      }
    });
    elements.detailContainer.append(mediaWrapper);
  }

  const metrics = document.createElement('div');
  metrics.className = 'mt-4 flex flex-wrap gap-3 text-xs text-slate-400';
  const metricInfo = [
    ['Likes', tweet?.likeCount],
    ['Replies', tweet?.replyCount],
    ['Retweets', tweet?.retweetCount],
    ['Quotes', tweet?.quoteCount],
    ['Views', tweet?.viewCount]
  ];
  metricInfo.forEach(([label, value]) => {
    if (typeof value === 'number') {
      const badge = document.createElement('span');
      badge.textContent = `${label}: ${formatCount(value)}`;
      metrics.append(badge);
    }
  });
  if (metrics.children.length > 0) {
    elements.detailContainer.append(metrics);
  }

  const footer = document.createElement('div');
  footer.className = 'mt-6 flex justify-end border-t border-slate-800/60 pt-4';

  const viewButton = document.createElement('a');
  viewButton.href = item.url;
  viewButton.target = '_blank';
  viewButton.rel = 'noopener noreferrer';
  viewButton.className = 'rounded-md border border-sky-500 px-4 py-2 text-sm font-semibold text-sky-300 transition hover:bg-sky-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50';
  viewButton.textContent = 'View original tweet';
  footer.append(viewButton);
  elements.detailContainer.append(footer);
}

function collectMedia(tweet = {}) {
  const media = [];
  const extended = tweet.extendedEntities?.media || tweet.extended_entities?.media || [];
  if (Array.isArray(extended)) {
    media.push(...extended);
  }
  return media;
}

function selectVideoVariant(media) {
  const variants = media.video_info?.variants || [];
  const mp4 = variants
    .filter((variant) => variant.content_type?.includes('mp4') && variant.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4[0]?.url || variants[0]?.url || null;
}

function toggleEmptyState() {
  const hasItems = state.items.length > 0;
  elements.emptyState.classList.toggle('hidden', hasItems);
  elements.list.classList.toggle('hidden', !hasItems);
}

function focusTweetInput() {
  setTimeout(() => elements.input.focus(), 0);
}

function clearMessage() {
  elements.message.textContent = '';
  elements.message.className = `text-sm min-h-[1.25rem] ${palette.neutral}`;
}

function showMessage(text, tone = 'error') {
  elements.message.textContent = text;
  elements.message.className = `text-sm min-h-[1.25rem] ${palette[tone] || palette.error}`;
}

function showApiKeyMessage(text, tone = 'info') {
  elements.apiKeyMessage.textContent = text;
  elements.apiKeyMessage.className = `mt-3 text-sm min-h-[1.25rem] ${palette[tone] || palette.info}`;
}

function setApiKeyModal(isVisible, { allowCancel = false, presetKey = '' } = {}) {
  if (isVisible) {
    elements.apiKeyInput.value = presetKey;
    elements.apiKeyCancel.classList.toggle('hidden', !allowCancel);
    elements.modal.classList.remove('hidden');
    showApiKeyMessage('');
    setTimeout(() => elements.apiKeyInput.focus(), 0);
  } else {
    elements.modal.classList.add('hidden');
    elements.apiKeyInput.value = '';
    showApiKeyMessage('');
  }
}

function setSavingState(isSaving) {
  state.isSaving = isSaving;
  elements.saveButton.textContent = isSaving ? 'Saving...' : 'Save';
}

function setAuthenticating(isAuthenticating) {
  state.isAuthenticating = isAuthenticating;
  elements.apiKeySubmit.disabled = isAuthenticating;
  elements.apiKeySubmit.textContent = isAuthenticating ? 'Verifying...' : 'Save Key';
}

async function authenticateKey(key) {
  setAuthenticating(true);
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
  } finally {
    setAuthenticating(false);
    updateSaveButtonState();
  }
}

async function handleApiKeySubmit() {
  const key = elements.apiKeyInput.value.trim();
  if (!key) {
    showApiKeyMessage('Please enter your twitterapi.io API key.', 'error');
    return;
  }

  showApiKeyMessage('Verifying key...', 'info');
  try {
    await authenticateKey(key);
    showApiKeyMessage('API key verified.', 'success');
    setApiKeyModal(false);
    focusTweetInput();
  } catch (error) {
    showApiKeyMessage(error.message || 'Unable to verify key.', 'error');
  }
}

async function fetchTweet(tweetId) {
  const response = await fetch(ENDPOINTS.TWEET, {
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
    throw new Error('Tweet not found.');
  }

  return data.tweet;
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
