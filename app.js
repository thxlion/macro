'use strict';

console.log('[app] Bootstrapping Tweet Link Saver');

import {
  setupAuthLayer,
  subscribeToAuthChanges,
  requestMagicLink,
  completeSignInFromLink,
  signOutUser
} from './services/auth.js';
import { setupSyncLayer, handleAuthStateChange, subscribeToSyncChanges } from './services/sync.js';
import {
  fetchRemoteApiKey,
  storeRemoteApiKey,
  deleteRemoteApiKey
} from './services/user-store.js';

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
  error: 'text-rose-500',
  info: 'text-amber-600',
  success: 'text-emerald-600',
  neutral: 'text-slate-600'
});

const state = {
  items: [],
  apiKey: null,
  credits: null,
  isSaving: false,
  isAuthenticating: false,
  activeTweetId: null,
  threads: {},
  threadStatus: {},
  auth: {
    status: 'offline-only',
    user: null,
    email: null,
    available: false,
    error: null,
    linkSentTo: null
  },
  sync: {
    status: 'disabled',
    lastSyncedAt: null,
    pending: 0,
    error: null
  },
  keyPromptPending: false
};

const elements = {};
let authSubmitInFlight = false;
let contextMenuState = null;
let undoState = null;
let toastTimer = null;

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
    creditsBadge: document.getElementById('creditsBadge'),
    header: document.getElementById('appHeader'),
    profileDivider: document.getElementById('profileDivider'),
    authSummary: document.getElementById('authSummary'),
    profileButton: document.getElementById('profileButton'),
    profileButtonLabel: document.getElementById('profileButtonLabel'),
    profileMenu: document.getElementById('profileMenu'),
    profileReplaceKey: document.getElementById('profileReplaceKey'),
    profileSignOut: document.getElementById('profileSignOut'),
    modal: document.getElementById('apiKeyModal'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    apiKeySubmit: document.getElementById('apiKeySubmitButton'),
    apiKeyCancel: document.getElementById('apiKeyCancelButton'),
    apiKeyMessage: document.getElementById('apiKeyMessage'),
    authModal: document.getElementById('authModal'),
    authEmailInput: document.getElementById('authEmailInput'),
    authSubmitButton: document.getElementById('authSubmitButton'),
    authMessage: document.getElementById('authMessage'),
    detailModal: document.getElementById('detailModal'),
    detailPlaceholder: document.getElementById('detailPlaceholder'),
    detailContainer: document.getElementById('detailContainer'),
    detailCloseButton: document.getElementById('detailCloseButton'),
    detailTitle: document.getElementById('detailTitle'),
    contextMenu: document.getElementById('contextMenu'),
    contextOpen: document.getElementById('contextOpen'),
    contextDelete: document.getElementById('contextDelete'),
    toast: document.getElementById('toast'),
    toastMessage: document.getElementById('toastMessage'),
    toastUndo: document.getElementById('toastUndo'),
    listMeta: document.getElementById('listMeta'),
    listMetaCount: document.getElementById('listMetaCount'),
    listMetaAdded: document.getElementById('listMetaAdded')
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
  if (elements.apiKeyCancel) {
    elements.apiKeyCancel.addEventListener('click', () => {
      setApiKeyModal(false);
      focusTweetInput();
    });
  }

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

  if (elements.profileReplaceKey) {
    elements.profileReplaceKey.addEventListener('click', () => {
      hideProfileMenu();
      promptForApiKey({ allowCancel: true, presetKey: state.apiKey || '', message: 'Replace your twitterapi.io API key.' });
    });
  }

  if (elements.profileSignOut) {
    elements.profileSignOut.addEventListener('click', () => {
      hideProfileMenu();
      signOutUser();
    });
  }

  if (elements.profileButton) {
    elements.profileButton.addEventListener('click', () => {
      closeContextMenu();
      if (state.auth.status !== 'signed-in') {
        state.auth.error = null;
        showAuthMessage('');
        setAuthModal(true, { presetEmail: state.auth.email || state.auth.linkSentTo || '' });
        return;
      }
      toggleProfileMenu();
    });
  }

  if (elements.contextOpen) {
    elements.contextOpen.addEventListener('click', () => {
      const current = contextMenuState;
      closeContextMenu();
      if (!current?.item) return;
      const url = current.item.url || (current.item.tweetId ? `https://twitter.com/i/web/status/${current.item.tweetId}` : null);
      if (url) {
        window.open(url, '_blank', 'noopener');
      }
      contextMenuState = null;
    });
  }

  if (elements.contextDelete) {
    elements.contextDelete.addEventListener('click', () => {
      const current = contextMenuState;
      closeContextMenu();
      if (!current?.item) return;
      const result = deleteItem(current.item.tweetId, { silent: true });
      renderItems();
      renderDetail();
      updateSaveButtonState();
      if (result) {
        showUndoToast(result);
      }
    });
  }

  if (elements.toastUndo) {
    elements.toastUndo.addEventListener('click', undoDelete);
  }

  if (elements.authSubmitButton) {
    elements.authSubmitButton.addEventListener('click', handleAuthSubmit);
  }

  if (elements.authEmailInput) {
    elements.authEmailInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleAuthSubmit();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setAuthModal(false);
        focusTweetInput();
      }
    });
  }

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
    if (event.key === 'Escape') {
      hideProfileMenu();
      closeContextMenu();
    }
  });

  document.addEventListener('click', (event) => {
    if (elements.profileMenu && !elements.profileMenu.classList.contains('hidden')) {
      const insideButton = elements.profileButton?.contains(event.target);
      const insideMenu = elements.profileMenu.contains(event.target);
      if (!insideButton && !insideMenu) {
        hideProfileMenu();
      }
    }
    if (elements.contextMenu && !elements.contextMenu.classList.contains('hidden')) {
      if (!elements.contextMenu.contains(event.target)) {
        closeContextMenu();
      }
    }
  });

  window.addEventListener('scroll', closeContextMenu, true);
  window.addEventListener('resize', closeContextMenu);
}

function initialize() {
  setupAuthLayer(state);
  setupSyncLayer(state);
  subscribeToAuthChanges((authState) => {
    renderAuthState(authState);
    handleAuthStateChange(authState);
    if (authState.status === 'signed-in') {
      refreshRemoteApiKey();
    } else if (authState.available && authState.status === 'signed-out') {
      state.keyPromptPending = true;
      if (elements.profileButton) {
        setAuthModal(true, { presetEmail: authState.email || authState.linkSentTo || '' });
      }
    }
  });
  subscribeToSyncChanges(renderSyncState);
  renderAuthState();
  completeSignInFromLink().finally(() => renderAuthState());
  loadStoredItems();
  loadStoredThreads();
  removeOrphanedThreads();
  renderItems();
  renderDetail();
  updateSaveButtonState();
  updateKeyStatus();

  state.keyPromptPending = true;

  if (elements.message) {
    elements.message.classList.add('hidden');
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
  return null;
}

function persistApiKey(_key) {
  // API key persists only in memory and is synced via the account store.
}

function removeStoredApiKey() {
  if (state.auth.status === 'signed-in') {
    deleteRemoteApiKey().catch((error) => {
      console.warn('[sync] Failed to remove API key from cloud store', error);
    });
  }
  state.keyPromptPending = true;
  state.apiKey = null;
  state.credits = null;
  updateKeyStatus();
}

function updateSaveButtonState() {
  const value = elements.input.value.trim();
  const tweetId = extractTweetId(value);
  const disabled = !tweetId || !state.apiKey || state.isSaving || state.isAuthenticating;
  elements.saveButton.disabled = disabled;
  if (!elements.saveButton) return;
  if (!tweetId || state.isSaving || state.isAuthenticating) {
    elements.saveButton.classList.remove('is-visible');
  } else {
    elements.saveButton.classList.add('is-visible');
  }
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
  showMessage('', 'info');

  const placeholderId = `pending-${Date.now()}`;
  const placeholderItem = {
    tweetId: placeholderId,
    url: rawValue,
    tweet: {
      author: { name: 'Fetching…' },
      text: rawValue
    },
    savedAt: Date.now(),
    isPending: true
  };
  state.items.unshift(placeholderItem);
  renderItems();

  try {
    const tweet = await fetchTweet(tweetId);
    const newItem = {
      tweetId,
      url: rawValue,
      tweet,
      savedAt: Date.now()
    };
    const previousActiveId = state.activeTweetId;
    const placeholderIndex = state.items.findIndex((entry) => entry.isPending && entry.tweetId === placeholderId);
    if (placeholderIndex !== -1) {
      state.items.splice(placeholderIndex, 1);
    }
    state.items.unshift(newItem);
    state.activeTweetId = previousActiveId;
    persistItems();
    renderItems();
    if (previousActiveId) {
      renderDetail();
    }
    loadThread(tweetId);
    elements.input.value = '';
    showMessage('Tweet saved.', 'success');
  } catch (error) {
    const placeholderIndex = state.items.findIndex((entry) => entry.isPending && entry.tweetId === placeholderId);
    if (placeholderIndex !== -1) {
      state.items.splice(placeholderIndex, 1);
      renderItems();
    }
    showMessage(error.message || 'Unable to save tweet.');
  } finally {
    setSavingState(false);
    updateSaveButtonState();
    focusTweetInput();
  }
}

function deleteItem(tweetId, { silent = false } = {}) {
  const index = state.items.findIndex((entry) => entry.tweetId === tweetId);
  if (index === -1) return null;

  const [removed] = state.items.splice(index, 1);
  persistItems();

  let thread = null;
  if (tweetId) {
    if (state.threads[tweetId]) {
      thread = state.threads[tweetId];
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

  if (!silent) {
    renderItems();
    renderDetail();
    updateSaveButtonState();
  }

  return { item: removed, index, thread };
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

function formatDateShort(value) {
  if (!value) return '';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
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
  closeContextMenu();
  elements.list.innerHTML = '';
  toggleEmptyState();
  updateListMeta();

  state.items.forEach((item, index) => {
    const listItem = document.createElement('li');

    const wrapper = document.createElement('div');
    const isActive = state.activeTweetId === item.tweetId;
    const isPending = Boolean(item.isPending);
    wrapper.className = [
      'list-item',
      isPending ? 'list-item--pending' : null,
      isActive ? 'list-item--selected' : null
    ].filter(Boolean).join(' ');

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'list-item__button focus:outline-none';
    selectButton.style.paddingLeft = '0';
    selectButton.style.paddingRight = '0';
    if (!isPending) {
      selectButton.addEventListener('click', () => selectItem(item.tweetId));
    } else {
      selectButton.disabled = true;
    }

    const avatar = createAvatarElement(item.tweet?.author, 20);
    avatar.classList.add('list-item__avatar');

    const textColumn = document.createElement('div');
    textColumn.className = 'list-item__text';

    const snippet = document.createElement('p');
    snippet.className = 'list-item__title truncate';
    const firstLine = (getTweetText(item.tweet) || item.url || '').split(/\r?\n/)[0];
    snippet.textContent = isPending ? 'Fetching tweet…' : firstLine || 'Saved tweet';

    const authorLine = document.createElement('p');
    authorLine.className = 'list-item__subtitle truncate';
    if (isPending) {
      authorLine.textContent = 'Please wait…';
    } else if (item.tweet?.author) {
      const { name } = item.tweet.author;
      authorLine.textContent = name ? `By ${name}` : 'By Unknown';
    } else {
      authorLine.textContent = 'By Unknown';
    }

    textColumn.append(snippet, authorLine);

    const dateLabel = document.createElement('span');
    dateLabel.className = 'list-item__date whitespace-nowrap';
    dateLabel.textContent = !isPending && item.savedAt ? formatDateShort(item.savedAt) : '';

    selectButton.append(avatar, textColumn, dateLabel);

    wrapper.append(selectButton);
    listItem.append(wrapper);
    elements.list.append(listItem);
    if (!isPending) {
      wrapper.addEventListener('contextmenu', (event) => {
        openContextMenu(event, item, index);
      });
    }
  });
}

function renderAuthState(authState = state.auth) {
  const profileButton = elements.profileButton;
  const profileLabel = elements.profileButtonLabel;
  const creditsBadge = elements.creditsBadge;
  const profileDivider = elements.profileDivider;
  const header = elements.header;
  if (!profileButton) return;

  if (header && authState?.available) {
    header.classList.remove('invisible');
  }

  if (!authState?.available) {
    if (profileLabel) profileLabel.textContent = 'Sync unavailable';
    setProfileButtonDisabled(true);
    if (creditsBadge) creditsBadge.classList.add('hidden');
    if (profileDivider) profileDivider.classList.add('hidden');
    return;
  }

  const status = authState.status;

  if (status === 'signed-in' && authState.user) {
    setAuthModal(false);
    const email = authState.user.email || 'account';
    if (profileLabel) profileLabel.textContent = email;
    setProfileButtonDisabled(false);
    if (creditsBadge) {
      if (typeof state.credits === 'number') {
        creditsBadge.textContent = `Credits ${state.credits.toLocaleString()}`;
        creditsBadge.classList.remove('hidden');
        if (profileDivider) profileDivider.classList.remove('hidden');
      } else {
        creditsBadge.classList.add('hidden');
        if (profileDivider) profileDivider.classList.add('hidden');
      }
    }
    hideProfileMenu();
    if (elements.authSummary) {
      elements.authSummary.textContent = '';
    }
  } else {
    hideProfileMenu();
    if (creditsBadge) creditsBadge.classList.add('hidden');
    if (profileDivider) profileDivider.classList.add('hidden');
    let label = 'Sign in';
    setProfileButtonDisabled(false);
    if (status === 'initializing') {
      label = 'Checking sync…';
      setProfileButtonDisabled(true);
    } else if (status === 'link-sent' && authState.linkSentTo) {
      label = `Link sent to ${authState.linkSentTo}`;
    }
    if (profileLabel) profileLabel.textContent = label;
    if (!state.apiKey) {
      state.keyPromptPending = true;
    }
    if (elements.authSummary) {
      if (status === 'link-sent' && authState.linkSentTo) {
        elements.authSummary.textContent = `Magic link sent to ${authState.linkSentTo}`;
      } else {
        elements.authSummary.textContent = '';
      }
    }
  }

  if (authState.error) {
    console.warn('Sync auth error:', authState.error);
  }
}

function renderSyncState(syncState = state.sync) {
  if (!syncState) return;
  // Future enhancement: surface sync status in the UI. For now we keep this hook for upcoming work.
}

function toggleProfileMenu() {
  if (!elements.profileMenu) return;
  elements.profileMenu.classList.toggle('hidden');
}

function hideProfileMenu() {
  if (!elements.profileMenu) return;
  elements.profileMenu.classList.add('hidden');
}

function setProfileButtonDisabled(isDisabled) {
  if (!elements.profileButton) return;
  elements.profileButton.disabled = isDisabled;
  elements.profileButton.classList.toggle('opacity-50', isDisabled);
  elements.profileButton.classList.toggle('cursor-not-allowed', isDisabled);
  elements.profileButton.classList.toggle('cursor-pointer', !isDisabled);
}

function openContextMenu(event, item, index) {
  const menu = elements.contextMenu;
  if (!menu) return;
  event.preventDefault();
  closeContextMenu();
  hideProfileMenu();

  contextMenuState = { item, index };
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  const padding = 8;
  let left = event.clientX;
  let top = event.clientY;
  if (left + rect.width > window.innerWidth - padding) {
    left = window.innerWidth - rect.width - padding;
  }
  if (top + rect.height > window.innerHeight - padding) {
    top = window.innerHeight - rect.height - padding;
  }
  menu.style.left = `${Math.max(padding, left)}px`;
  menu.style.top = `${Math.max(padding, top)}px`;
}

function closeContextMenu() {
  if (!elements.contextMenu) return;
  elements.contextMenu.classList.add('hidden');
  elements.contextMenu.style.left = '';
  elements.contextMenu.style.top = '';
  contextMenuState = null;
}

async function refreshRemoteApiKey() {
  if (state.auth.status !== 'signed-in') return;
  try {
    const { apiKey } = await fetchRemoteApiKey();
    if (!apiKey || typeof apiKey !== 'string') {
      if (state.keyPromptPending || !state.apiKey) {
        promptForApiKey({ allowCancel: false, presetKey: state.apiKey || '', message: 'Add your twitterapi.io API key to finish signing in.' });
      }
      return;
    }
    const trimmed = apiKey.trim();
    if (!trimmed || trimmed === state.apiKey) {
      state.keyPromptPending = false;
      return;
    }
    console.log('[sync] Applying remote API key');
    await authenticateKey(trimmed, { skipRemoteStore: true });
    state.keyPromptPending = false;
  } catch (error) {
    console.warn('[sync] Unable to refresh remote API key', error);
  }
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
  fallback.className = 'flex items-center justify-center rounded-full bg-slate-200 text-sm font-light text-slate-600';
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
  header.className = 'flex items-start gap-3 border-b border-slate-200 pb-4';
  header.append(createAvatarElement(leadTweet?.author, 64));

  const identity = document.createElement('div');
  identity.className = 'space-y-1';

  const nameLine = document.createElement('p');
  nameLine.className = 'text-base font-light text-[#1B1D1F]';
  nameLine.textContent = leadTweet?.author?.name || 'Unknown';
  identity.append(nameLine);

  if (leadTweet?.author?.userName) {
    const username = document.createElement('p');
    username.className = 'text-sm text-slate-500';
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
    loadingMessage.className = 'mt-6 text-sm text-slate-500';
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
    retryButton.className = 'mt-3 rounded-md border border-[#1B1D1F] px-3 py-1 text-xs font-light text-[#1B1D1F] transition hover:bg-[rgba(27,29,31,0.1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1B1D1F]/40';
    retryButton.textContent = 'Retry';
    retryButton.addEventListener('click', () => loadThread(item.tweetId, { force: true }));
    errorWrapper.append(retryButton);

    elements.detailContainer.append(errorWrapper);
    return;
  }

  const articleWrapper = document.createElement('div');
  articleWrapper.className = 'mt-4 space-y-4 text-sm leading-relaxed text-[#1B1D1F] sm:text-base';

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
      } else if (block.type === 'media' && Array.isArray(block.items) && block.items.length > 0) {
        articleWrapper.append(createMediaGroup(block.items));
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

  const footer = document.createElement('div');
  footer.className = 'mt-6 flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between';

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
  viewButton.className = 'rounded-md border border-[#1B1D1F] px-4 py-2 text-sm font-light text-[#1B1D1F] transition hover:bg-[rgba(27,29,31,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1B1D1F]/40';
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
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regexp = new RegExp(escaped, 'g');
        processedText = processedText.replace(regexp, '').trim();
      });
    });

    const paragraphs = processedText
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean);

    if (paragraphs.length === 0 && processedText.trim()) {
      paragraphs.push(processedText.trim());
    }

    paragraphs.forEach((chunk) => {
      blocks.push({ type: 'text', text: chunk });
    });

    links.forEach((link) => {
      const card = buildLinkCardData(link);
      if (card) {
        blocks.push({ type: 'link-card', link: card });
      }
    });

    const mediaItems = collectMedia(tweet);
    if (Array.isArray(mediaItems) && mediaItems.length > 0) {
      blocks.push({
        type: 'media',
        items: mediaItems.map((item) => ({ ...item }))
      });
    }
  });
  return blocks;
}

function createMediaGroup(mediaItems) {
  if (!Array.isArray(mediaItems) || mediaItems.length === 0) {
    return document.createDocumentFragment();
  }

  if (mediaItems.length === 1) {
    return createSingleMediaCard(mediaItems[0]);
  }

  const grid = document.createElement('div');
  grid.className = 'grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2';
  mediaItems.forEach((item) => {
    grid.append(createSingleMediaCard(item, true));
  });
  return grid;
}

function createSingleMediaCard(media, isNested = false) {
  if (!media) return document.createDocumentFragment();

  if (media.type === 'video' || media.type === 'animated_gif') {
    const container = document.createElement('div');
    container.className = isNested
      ? 'rounded-xl border border-slate-200 bg-white p-2'
      : 'overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 p-3';

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
    container.append(video);
    return container;
  }

  if (media.type === 'photo' || media.media_url_https || media.media_url) {
    const figure = document.createElement('figure');
    figure.className = isNested
      ? 'overflow-hidden rounded-xl border border-slate-200 bg-white'
      : 'overflow-hidden rounded-2xl border border-slate-200 bg-slate-50';

    const img = document.createElement('img');
    img.src = media.media_url_https || media.media_url;
    img.alt = media.alt_text || media.ext_alt_text || 'Thread image';
    img.loading = 'lazy';
    img.className = 'h-full w-full object-cover';
    figure.append(img);
    return figure;
  }

  return document.createDocumentFragment();
}

function createLinkPreview(link) {
  const anchor = document.createElement('a');
  anchor.href = link.href || link.url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.className = 'flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-[#1B1D1F]/40 hover:bg-slate-50';

  const textColumn = document.createElement('div');
  textColumn.className = 'flex min-w-0 flex-1 flex-col';

  const titleElement = document.createElement('p');
  titleElement.className = 'truncate text-sm font-light text-[#1B1D1F] sm:text-base';
  titleElement.textContent = link.title;
  textColumn.append(titleElement);

  if (link.displayUrl) {
    const urlElement = document.createElement('p');
    urlElement.className = 'mt-1 truncate text-xs text-slate-500';
    urlElement.textContent = link.displayUrl;
    textColumn.append(urlElement);
  }

  const imageWrapper = document.createElement('div');
  imageWrapper.className = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50';

  if (link.favicon) {
    const img = document.createElement('img');
    img.src = link.favicon;
    img.alt = link.domain ? `${link.domain} favicon` : 'Link preview';
    img.loading = 'lazy';
    img.className = 'h-8 w-8 rounded object-contain';
    imageWrapper.append(img);
  } else if (link.domainInitial) {
    const fallback = document.createElement('span');
    fallback.className = 'text-sm font-light text-slate-500';
    fallback.textContent = link.domainInitial;
    imageWrapper.append(fallback);
  }

  anchor.append(imageWrapper, textColumn);
  return anchor;
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
  const rootAuthorKeys = getAuthorKeys(rootTweet);

  const pushTweet = (tweet, { allowAnyAuthor = false } = {}) => {
    if (!tweet || typeof tweet !== 'object') return;
    const id = getTweetId(tweet);
    if (!id || seen.has(id)) return;
    seen.add(id);

    if (!allowAnyAuthor && rootAuthorKeys.size > 0) {
      const authorKeys = getAuthorKeys(tweet);
      const isSameAuthor = Array.from(authorKeys).some((key) => rootAuthorKeys.has(key));
      if (!isSameAuthor) return;
    }

    const timestamp = getTweetTimestamp(tweet);
    entries.push({
      tweet,
      hasTimestamp: timestamp !== null,
      timestamp: timestamp ?? 0,
      sequence: sequence++
    });
  };

  pushTweet(rootTweet, { allowAnyAuthor: true });
  if (Array.isArray(fetchedTweets)) {
    fetchedTweets.forEach((item) => pushTweet(item));
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

function getAuthorKeys(tweet) {
  const keys = new Set();
  if (!tweet || typeof tweet !== 'object') return keys;

  const addId = (value) => {
    if (value === undefined || value === null) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    keys.add(`id:${normalized}`);
  };

  const addHandle = (value) => {
    if (!value) return;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return;
    keys.add(`handle:${normalized}`);
  };

  const author = tweet.author || tweet.user;
  if (author) {
    addId(author.id ?? author.rest_id ?? author.userId ?? author.user_id ?? author.id_str);
    addHandle(author.userName ?? author.username ?? author.screen_name ?? author.handle);
  }

  if (tweet.legacy) {
    addId(tweet.legacy.user_id_str);
    addHandle(tweet.legacy.screen_name);
  }

  const coreUser = tweet.core?.user_results?.result;
  if (coreUser) {
    addId(coreUser.rest_id);
    addHandle(coreUser.legacy?.screen_name);
  }

  const result = tweet.user_results?.result;
  if (result) {
    addId(result.rest_id);
    addHandle(result.legacy?.screen_name);
  }

  return keys;
}

function collectMedia(tweet = {}) {
  const collected = [];
  const seen = new Set();
  const sources = [
    tweet.extendedEntities?.media,
    tweet.extended_entities?.media,
    tweet.entities?.media,
    tweet.legacy?.extended_entities?.media,
    tweet.legacy?.extendedEntities?.media,
    tweet.legacy?.entities?.media
  ];

  sources.forEach((mediaList) => {
    if (!Array.isArray(mediaList)) return;
    mediaList.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const key = item.id || item.media_key || item.mediaKey || item.media_url_https || item.media_url;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      collected.push(item);
    });
  });

  return collected;
}

function selectVideoVariant(media) {
  const candidateSets = [
    media.video_info?.variants,
    media.videoInfo?.variants,
    media.legacy?.video_info?.variants,
    media.videoVariants,
    media.variants,
    media.ext?.variants
  ].filter(Boolean);

  const variants = [];
  candidateSets.forEach((set) => {
    if (Array.isArray(set)) {
      variants.push(...set);
    }
  });
  const mp4 = variants
    .filter((variant) => variant.content_type?.includes('mp4') && variant.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4[0]?.url || variants[0]?.url || null;
}

function toggleEmptyState() {
  const hasItems = state.items.length > 0;
  elements.emptyState.classList.toggle('hidden', hasItems);
  elements.list.classList.toggle('hidden', !hasItems);
  if (elements.listMeta) {
    elements.listMeta.classList.toggle('hidden', !hasItems);
  }
}

function updateListMeta() {
  if (!elements.listMetaCount) return;
  const count = state.items.length;
  const label = count === 1 ? 'Article' : 'Articles';
  elements.listMetaCount.textContent = `${count} ${label}`;
}

function focusTweetInput() {
  setTimeout(() => elements.input.focus(), 0);
}

function clearMessage() {
  if (!elements.message) return;
  elements.message.textContent = '';
  elements.message.className = 'form-message hidden';
}

function showMessage(text, tone = 'error') {
  if (!elements.message) return;
  if (!text) {
    clearMessage();
    return;
  }
  elements.message.textContent = text;
  elements.message.className = `form-message ${palette[tone] || palette.error}`;
}

function showApiKeyMessage(text, tone = 'info') {
  elements.apiKeyMessage.textContent = text;
  elements.apiKeyMessage.className = `mt-3 text-sm min-h-[1.25rem] ${palette[tone] || palette.info}`;
}

function promptForApiKey({ allowCancel = false, presetKey = '', message = 'Enter your twitterapi.io API key to finish setup.' } = {}) {
  if (!elements.modal) return;
  if (!elements.modal.classList.contains('hidden')) {
    showApiKeyMessage(message, 'info');
    state.keyPromptPending = false;
    return;
  }
  setApiKeyModal(true, { allowCancel, presetKey });
  showApiKeyMessage(message, 'info');
  state.keyPromptPending = false;
}

function showUndoToast({ item, index, thread }) {
  if (!elements.toast || !elements.toastMessage) return;
  hideToast();
  undoState = { item, index, thread };
  elements.toastMessage.textContent = 'Tweet deleted';
  elements.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => {
    hideToast();
    undoState = null;
  }, 5000);
}

function hideToast() {
  if (!elements.toast) return;
  elements.toast.classList.add('hidden');
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

function undoDelete() {
  if (!undoState) {
    hideToast();
    return;
  }
  const { item, index, thread } = undoState;
  const insertIndex = typeof index === 'number' ? Math.min(index, state.items.length) : 0;
  state.items.splice(insertIndex, 0, item);
  persistItems();
  if (thread) {
    state.threads[item.tweetId] = thread;
    state.threadStatus[item.tweetId] = { loading: false, error: null };
    persistThreads();
  }
  renderItems();
  renderDetail();
  updateSaveButtonState();
  undoState = null;
  hideToast();
}

function showAuthMessage(text, tone = 'info') {
  if (!elements.authMessage) return;
  const toneClass = palette[tone] || palette.info;
  elements.authMessage.textContent = text;
  elements.authMessage.className = `mt-3 text-sm min-h-[1.25rem] ${toneClass}`;
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

function setAuthModal(isVisible, { presetEmail = '' } = {}) {
  if (!elements.authModal) return;
  if (isVisible) {
    elements.authModal.classList.remove('hidden');
    if (elements.authEmailInput) {
      elements.authEmailInput.value = presetEmail;
      setTimeout(() => elements.authEmailInput?.focus(), 0);
    }
    showAuthMessage('');
  } else {
    elements.authModal.classList.add('hidden');
    authSubmitInFlight = false;
    if (elements.authEmailInput) {
      elements.authEmailInput.value = '';
    }
    if (elements.authSubmitButton) {
      elements.authSubmitButton.disabled = false;
      elements.authSubmitButton.textContent = 'Send link';
    }
    showAuthMessage('');
  }
}

function setSavingState(isSaving) {
  state.isSaving = isSaving;
}

function setAuthenticating(isAuthenticating) {
  state.isAuthenticating = isAuthenticating;
  elements.apiKeySubmit.disabled = isAuthenticating;
  elements.apiKeySubmit.textContent = isAuthenticating ? 'Verifying...' : 'Save Key';
}

async function authenticateKey(key, { skipRemoteStore = false } = {}) {
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
    if (!skipRemoteStore && state.auth.status === 'signed-in') {
      storeRemoteApiKey(key).catch((error) => {
        console.warn('[sync] Failed to persist API key remotely', error);
      });
    }
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
    state.keyPromptPending = false;
    setApiKeyModal(false);
    focusTweetInput();
  } catch (error) {
    showApiKeyMessage(error.message || 'Unable to verify key.', 'error');
  }
}

async function handleAuthSubmit(event) {
  if (event) {
    event.preventDefault();
  }
  if (!elements.authEmailInput || !elements.authSubmitButton) return;
  const rawEmail = elements.authEmailInput.value.trim();
  if (!rawEmail) {
    showAuthMessage('Please enter your email address.', 'error');
    return;
  }
  if (!state.auth.available) {
    showAuthMessage('Sync is not configured yet.', 'error');
    return;
  }
  if (authSubmitInFlight) return;
  authSubmitInFlight = true;
  elements.authSubmitButton.disabled = true;
  elements.authSubmitButton.textContent = 'Sending...';
  showAuthMessage('Sending magic link...', 'info');

  try {
    await requestMagicLink(rawEmail);
    showAuthMessage(`Magic link sent to ${rawEmail}.`, 'success');
  } catch (error) {
    const message = error?.message || 'Unable to send magic link.';
    showAuthMessage(message, 'error');
  } finally {
    authSubmitInFlight = false;
    if (elements.authSubmitButton) {
      const linkSent = state.auth.status === 'link-sent';
      elements.authSubmitButton.disabled = false;
      elements.authSubmitButton.textContent = linkSent ? 'Resend link' : 'Send link';
    }
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

function updateKeyStatus() {
  if (!elements.creditsBadge) return;
  if (!state.apiKey) {
    elements.creditsBadge.classList.add('hidden');
    if (elements.profileDivider) elements.profileDivider.classList.add('hidden');
    return;
  }

  if (typeof state.credits === 'number') {
    elements.creditsBadge.textContent = `Credits ${state.credits.toLocaleString()}`;
    elements.creditsBadge.classList.remove('hidden');
    if (elements.profileDivider) elements.profileDivider.classList.remove('hidden');
  } else {
    elements.creditsBadge.classList.add('hidden');
    if (elements.profileDivider) elements.profileDivider.classList.add('hidden');
  }
}
