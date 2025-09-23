'use strict';

const ENDPOINTS = Object.freeze({
  VERIFY: '/api/verify',
  TWEET: '/api/tweets',
  THREAD: '/api/thread'
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
  API_KEY: 'tweet-link-saver-api-key',
  THREADS: 'tweet-link-saver-thread-cache'
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
  activeTweetId: null,
  threads: {},
  threadStatus: {}
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
  loadStoredThreads();
  removeOrphanedThreads();
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

function loadStoredThreads() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.THREADS);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    Object.entries(parsed).forEach(([tweetId, entry]) => {
      if (!tweetId || !entry || typeof entry !== 'object') return;
      const tweets = Array.isArray(entry.tweets) ? entry.tweets : [];
      if (!tweets.length) return;
      state.threads[tweetId] = {
        tweets,
        fetchedAt: typeof entry.fetchedAt === 'number' ? entry.fetchedAt : null,
        rootTweetId: entry.rootTweetId || null
      };
    });
  } catch (error) {
    console.error('Failed to load cached threads', error);
  }
}

function persistThreads() {
  try {
    const serializable = {};
    Object.entries(state.threads).forEach(([tweetId, entry]) => {
      if (!tweetId || !entry || typeof entry !== 'object') return;
      if (!Array.isArray(entry.tweets) || entry.tweets.length === 0) return;
      serializable[tweetId] = {
        tweets: entry.tweets,
        fetchedAt: typeof entry.fetchedAt === 'number' ? entry.fetchedAt : Date.now(),
        rootTweetId: entry.rootTweetId || null
      };
    });
    if (Object.keys(serializable).length === 0) {
      localStorage.removeItem(STORAGE_KEYS.THREADS);
      return;
    }
    localStorage.setItem(STORAGE_KEYS.THREADS, JSON.stringify(serializable));
  } catch (error) {
    console.error('Failed to persist cached threads', error);
  }
}

function removeOrphanedThreads() {
  const validIds = new Set(state.items.map((item) => item.tweetId));
  let didChange = false;
  Object.keys(state.threads).forEach((tweetId) => {
    if (validIds.has(tweetId)) return;
    delete state.threads[tweetId];
    delete state.threadStatus[tweetId];
    didChange = true;
  });
  if (didChange) {
    persistThreads();
  }
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
  if (tweetId) {
    if (state.threads[tweetId]) {
      delete state.threads[tweetId];
      persistThreads();
    }
    if (state.threadStatus[tweetId]) {
      delete state.threadStatus[tweetId];
    }
  }
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

  const status = ensureThreadStatus(item.tweetId);
  const cachedThread = state.threads[item.tweetId] || null;
  if (!cachedThread && state.apiKey && !status.loading && !status.error) {
    loadThread(item.tweetId);
  }

  const tweetsForArticle = buildThreadSequence(item.tweet, cachedThread?.tweets || []);
  const leadTweet = tweetsForArticle[0] || item.tweet;

  elements.detailPlaceholder.classList.add('hidden');
  elements.detailContainer.classList.remove('hidden');
  elements.detailContainer.innerHTML = '';
  elements.detailModal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');

  if (elements.detailTitle) {
    const author = leadTweet?.author;
    const parts = [author?.name || 'Thread'];
    if (author?.userName) parts.push(`@${author.userName}`);
    elements.detailTitle.textContent = parts.join(' · ');
  }

  const header = document.createElement('div');
  header.className = 'flex items-start gap-3 border-b border-slate-800/60 pb-4';
  header.append(createAvatarElement(leadTweet?.author, 64));

  const identity = document.createElement('div');
  identity.className = 'space-y-1';

  const nameLine = document.createElement('p');
  nameLine.className = 'text-base font-semibold text-slate-100';
  nameLine.textContent = leadTweet?.author?.name || 'Unknown';
  identity.append(nameLine);

  if (leadTweet?.author?.userName) {
    const username = document.createElement('p');
    username.className = 'text-sm text-slate-400';
    username.textContent = `@${leadTweet.author.userName}`;
    identity.append(username);
  }

  const metaLine = document.createElement('p');
  metaLine.className = 'text-xs text-slate-500';
  metaLine.textContent = formatDate(leadTweet?.createdAt || leadTweet?.created_at || leadTweet?.legacy?.created_at);
  identity.append(metaLine);

  header.append(identity);
  elements.detailContainer.append(header);

  if (status.loading && (!cachedThread || !cachedThread.tweets?.length)) {
    const loadingMessage = document.createElement('p');
    loadingMessage.className = 'mt-6 text-sm text-slate-400';
    loadingMessage.textContent = 'Loading full thread...';
    elements.detailContainer.append(loadingMessage);
    return;
  }

  if (status.error && (!cachedThread || !cachedThread.tweets?.length)) {
    const errorWrapper = document.createElement('div');
    errorWrapper.className = 'mt-6 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200';
    errorWrapper.textContent = status.error;

    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'mt-3 rounded-md border border-sky-500 px-3 py-1 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50';
    retryButton.textContent = 'Retry';
    retryButton.addEventListener('click', () => loadThread(item.tweetId, { force: true }));
    errorWrapper.append(retryButton);

    elements.detailContainer.append(errorWrapper);
    return;
  }

  const articleWrapper = document.createElement('div');
  articleWrapper.className = 'mt-4 space-y-4 text-sm leading-relaxed text-slate-100 sm:text-base';

  const contentBlocks = composeThreadContentBlocks(tweetsForArticle);
  if (contentBlocks.length > 0) {
    contentBlocks.forEach((block) => {
      if (block.type === 'text') {
        const paragraph = document.createElement('p');
        paragraph.className = 'whitespace-pre-wrap';
        paragraph.textContent = block.text;
        articleWrapper.append(paragraph);
      } else if (block.type === 'link-card') {
        articleWrapper.append(createLinkPreview(block.link));
      }
    });
  } else {
    const fallbackText = getTweetText(leadTweet);
    if (fallbackText) {
      const fallback = document.createElement('p');
      fallback.className = 'whitespace-pre-wrap';
      fallback.textContent = fallbackText;
      articleWrapper.append(fallback);
    }
  }

  elements.detailContainer.append(articleWrapper);

  const mediaItems = aggregateMediaFromTweets(tweetsForArticle);
  if (mediaItems.length > 0) {
    const mediaWrapper = document.createElement('div');
    mediaWrapper.className = 'mt-6 grid gap-4 sm:grid-cols-2';
    mediaItems.forEach((media) => {
      if (media.type === 'photo' || media.media_url_https || media.media_url) {
        const figure = document.createElement('figure');
        figure.className = 'overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80';

        const img = document.createElement('img');
        img.src = media.media_url_https || media.media_url;
        img.alt = media.alt_text || media.ext_alt_text || 'Thread image';
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
  metrics.className = 'mt-6 flex flex-wrap gap-3 text-xs text-slate-400';
  const metricInfo = [
    ['Likes', leadTweet?.likeCount],
    ['Replies', leadTweet?.replyCount],
    ['Retweets', leadTweet?.retweetCount],
    ['Quotes', leadTweet?.quoteCount],
    ['Views', leadTweet?.viewCount]
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
  footer.className = 'mt-6 flex flex-col gap-3 border-t border-slate-800/60 pt-4 sm:flex-row sm:items-center sm:justify-between';

  if (cachedThread?.fetchedAt) {
    const formatted = formatDate(cachedThread.fetchedAt);
    if (formatted) {
      const cachedTime = document.createElement('p');
      cachedTime.className = 'text-xs text-slate-500';
      cachedTime.textContent = `Thread cached on ${formatted}.`;
      footer.append(cachedTime);
    }
  }

  const viewButton = document.createElement('a');
  viewButton.href = item.url;
  viewButton.target = '_blank';
  viewButton.rel = 'noopener noreferrer';
  viewButton.className = 'rounded-md border border-sky-500 px-4 py-2 text-sm font-semibold text-sky-300 transition hover:bg-sky-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50';
  viewButton.textContent = 'View original tweet';
  footer.append(viewButton);

  elements.detailContainer.append(footer);
}

function composeThreadContentBlocks(tweets = []) {
  const blocks = [];
  tweets.forEach((tweet) => {
    if (!tweet || typeof tweet !== 'object') return;
    const text = getTweetText(tweet);
    const links = extractLinksFromTweet(tweet);

    let processedText = text;
    links.forEach((link) => {
      const candidates = [link.url, link.expandedUrl, link.expanded_url];
      candidates.forEach((value) => {
        if (!value) return;
        const regexp = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        processedText = processedText.replace(regexp, '').trim();
      });
    });

    processedText
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .forEach((chunk) => {
        blocks.push({ type: 'text', text: chunk });
      });

    links.forEach((link) => {
      const card = buildLinkCardData(link);
      if (card) {
        blocks.push({ type: 'link-card', link: card });
      }
    });
  });
  return blocks;
}

function createLinkPreview(link) {
  const anchor = document.createElement('a');
  anchor.href = link.href || link.url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.className = 'flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 transition hover:border-sky-500/40 hover:bg-slate-900';

  const textColumn = document.createElement('div');
  textColumn.className = 'flex min-w-0 flex-1 flex-col';

  const titleElement = document.createElement('p');
  titleElement.className = 'truncate text-sm font-semibold text-slate-100 sm:text-base';
  titleElement.textContent = link.title;
  textColumn.append(titleElement);

  if (link.displayUrl) {
    const urlElement = document.createElement('p');
    urlElement.className = 'mt-1 truncate text-xs text-slate-400';
    urlElement.textContent = link.displayUrl;
    textColumn.append(urlElement);
  }

  const imageWrapper = document.createElement('div');
  imageWrapper.className = 'flex h-12 w-12 items-center justify-center rounded-lg border border-slate-800 bg-slate-900/80';

  if (link.favicon) {
    const img = document.createElement('img');
    img.src = link.favicon;
    img.alt = link.domain ? `${link.domain} favicon` : 'Link preview';
    img.loading = 'lazy';
    img.className = 'h-8 w-8 rounded object-contain';
    imageWrapper.append(img);
  } else if (link.domainInitial) {
    const fallback = document.createElement('span');
    fallback.className = 'text-sm font-semibold text-slate-400';
    fallback.textContent = link.domainInitial;
    imageWrapper.append(fallback);
  }

  anchor.append(textColumn, imageWrapper);
  return anchor;
}

function aggregateMediaFromTweets(tweets = []) {
  const media = [];
  const seen = new Set();
  tweets.forEach((tweet) => {
    const items = collectMedia(tweet);
    if (!items.length) return;
    const sourceTweetId = getTweetId(tweet);
    items.forEach((item) => {
      const src = item?.media_url_https || item?.media_url || item?.url;
      const key = src || `${sourceTweetId || 'tweet'}-${item?.id || item?.media_key || media.length}`;
      if (seen.has(key)) return;
      seen.add(key);
      media.push({ ...item, sourceTweetId });
    });
  });
  return media;
}

function extractLinksFromTweet(tweet = {}) {
  const entities = tweet.entities || tweet.legacy?.entities || tweet.legacy?.extended_entities;
  const urls = Array.isArray(entities?.urls) ? entities.urls : [];
  const cardLinks = Array.isArray(tweet.cards) ? tweet.cards : [];
  const results = [];

  urls.forEach((entry) => {
    if (!entry) return;
    const expanded = entry.expanded_url || entry.expandedUrl || entry.unwound_url || entry.unwoundUrl || entry.url;
    if (!expanded) return;
    results.push({
      url: entry.url || expanded,
      expandedUrl: expanded,
      displayUrl: entry.display_url || entry.displayUrl || simplifyUrl(expanded),
      title: entry.title || entry.card_title || null
    });
  });

  cardLinks.forEach((card) => {
    if (!card || !card.url) return;
    const expanded = card.url;
    results.push({
      url: card.url,
      expandedUrl: expanded,
      displayUrl: card.display_url || simplifyUrl(expanded),
      title: card.title || card.name || null
    });
  });

  return results;
}

function buildLinkCardData(link) {
  try {
    const raw = link.expandedUrl || link.url;
    if (!raw) return null;
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const domain = url.hostname.replace(/^www\./i, '');
    const title = link.title || domain;
    const displayUrl = link.displayUrl || `${domain}${url.pathname !== '/' ? url.pathname : ''}`;
    return {
      href: url.href,
      url: link.url,
      title,
      displayUrl,
      domain,
      domainInitial: domain?.[0]?.toUpperCase() || null,
      favicon: getFaviconUrl(url)
    };
  } catch (error) {
    return null;
  }
}

function getFaviconUrl(url) {
  if (!url) return null;
  const origin = `${url.protocol}//${url.hostname}`;
  return `${origin}/favicon.ico`;
}

function simplifyUrl(value = '') {
  return value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function getTweetText(tweet) {
  if (!tweet || typeof tweet !== 'object') return '';
  const text = tweet.text
    || tweet.full_text
    || tweet.legacy?.full_text
    || tweet.legacy?.text
    || '';
  return typeof text === 'string' ? text : '';
}

function buildThreadSequence(rootTweet, fetchedTweets = []) {
  const entries = [];
  const seen = new Set();
  let sequence = 0;

  const pushTweet = (tweet) => {
    if (!tweet || typeof tweet !== 'object') return;
    const id = getTweetId(tweet);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const timestamp = getTweetTimestamp(tweet);
    entries.push({
      tweet,
      hasTimestamp: timestamp !== null,
      timestamp: timestamp ?? 0,
      sequence: sequence++
    });
  };

  pushTweet(rootTweet);
  if (Array.isArray(fetchedTweets)) {
    fetchedTweets.forEach(pushTweet);
  }

  entries.sort((a, b) => {
    if (a.hasTimestamp && b.hasTimestamp) {
      return a.timestamp - b.timestamp;
    }
    if (a.hasTimestamp) return -1;
    if (b.hasTimestamp) return 1;
    return a.sequence - b.sequence;
  });

  return entries.map((entry) => entry.tweet);
}

function ensureThreadStatus(tweetId) {
  if (!tweetId) {
    return { loading: false, error: null };
  }
  if (!state.threadStatus[tweetId]) {
    state.threadStatus[tweetId] = { loading: false, error: null };
  }
  return state.threadStatus[tweetId];
}

function updateThreadStatus(tweetId, updates) {
  if (!tweetId) return;
  const current = ensureThreadStatus(tweetId);
  state.threadStatus[tweetId] = { ...current, ...updates };
}

function sanitizeThreadTweets(tweets = []) {
  const seen = new Set();
  const normalized = [];
  tweets.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const id = getTweetId(entry);
    if (!id || seen.has(id)) return;
    seen.add(id);
    normalized.push(entry.id ? entry : { ...entry, id });
  });
  return normalized;
}

function getTweetId(tweet) {
  return tweet?.id || tweet?.tweet_id || tweet?.tweetId || tweet?.rest_id || null;
}

function getTweetTimestamp(tweet) {
  const raw = tweet?.createdAt || tweet?.created_at || tweet?.legacy?.created_at;
  if (!raw) return null;
  const date = new Date(raw);
  const value = date.getTime();
  return Number.isNaN(value) ? null : value;
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

async function loadThread(tweetId, { force = false } = {}) {
  if (!tweetId || !state.apiKey) return null;

  const cached = state.threads[tweetId];
  if (!force && cached && Array.isArray(cached.tweets) && cached.tweets.length > 0) {
    return cached;
  }

  const status = ensureThreadStatus(tweetId);
  if (status.loading) {
    return null;
  }

  updateThreadStatus(tweetId, { loading: true, error: null });
  renderDetail();

  try {
    const response = await fetch(ENDPOINTS.THREAD, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ apiKey: state.apiKey, tweetId })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data?.message || 'Unable to load thread.';
      throw new Error(message);
    }

    if (!Array.isArray(data?.tweets) || data.tweets.length === 0) {
      throw new Error('Thread data unavailable.');
    }

    const sanitized = sanitizeThreadTweets(data.tweets);
    state.threads[tweetId] = {
      tweets: sanitized,
      fetchedAt: typeof data?.fetchedAt === 'number' ? data.fetchedAt : Date.now(),
      rootTweetId: data?.rootTweetId || tweetId
    };
    updateThreadStatus(tweetId, { loading: false, error: null });
    persistThreads();
    return state.threads[tweetId];
  } catch (error) {
    console.error('Failed to load thread', error);
    updateThreadStatus(tweetId, { loading: false, error: error.message || 'Unable to load thread.' });
    return null;
  } finally {
    renderDetail();
  }
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
