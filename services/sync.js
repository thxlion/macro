'use strict';

const defaultSyncState = {
  status: 'disabled',
  lastSyncedAt: null,
  pending: 0,
  error: null
};

let syncStateRef = null;
const subscribers = new Set();
const mutationQueue = [];

function notifySubscribers() {
  if (!syncStateRef) return;
  subscribers.forEach((callback) => {
    try {
      callback(syncStateRef);
    } catch (error) {
      console.error('Sync subscriber error', error);
    }
  });
}

export function setupSyncLayer(state) {
  if (!state.sync) {
    state.sync = { ...defaultSyncState };
  } else {
    Object.assign(state.sync, defaultSyncState);
  }
  syncStateRef = state.sync;
  notifySubscribers();
  return syncStateRef;
}

export function handleAuthStateChange(authState = {}) {
  if (!syncStateRef) return;

  if (!authState.available) {
    Object.assign(syncStateRef, {
      status: 'disabled',
      error: null
    });
    notifySubscribers();
    return;
  }

  switch (authState.status) {
    case 'initializing':
      syncStateRef.status = 'initializing';
      syncStateRef.error = null;
      break;
    case 'signed-in':
      syncStateRef.status = 'idle';
      syncStateRef.error = null;
      break;
    case 'link-sent':
      syncStateRef.status = 'awaiting-confirmation';
      syncStateRef.error = null;
      break;
    case 'signed-out':
      syncStateRef.status = 'auth-required';
      syncStateRef.error = null;
      break;
    case 'offline-only':
      syncStateRef.status = 'disabled';
      syncStateRef.error = authState.error || null;
      break;
    default:
      syncStateRef.status = 'auth-required';
      break;
  }

  notifySubscribers();
}

export function queueSaveMutation(tweetPayload) {
  mutationQueue.push({ type: 'save', payload: tweetPayload, createdAt: Date.now() });
  updatePendingCount();
}

export function queueDeleteMutation(tweetId) {
  if (!tweetId) return;
  mutationQueue.push({ type: 'delete', tweetId, createdAt: Date.now() });
  updatePendingCount();
}

function updatePendingCount() {
  if (!syncStateRef) return;
  syncStateRef.pending = mutationQueue.length;
  notifySubscribers();
}

export function subscribeToSyncChanges(callback) {
  if (typeof callback !== 'function') {
    return () => {};
  }
  subscribers.add(callback);
  if (syncStateRef) {
    try {
      callback(syncStateRef);
    } catch (error) {
      console.error('Sync subscriber error', error);
    }
  }
  return () => subscribers.delete(callback);
}

export function getSyncState(state) {
  if (!state?.sync) return { ...defaultSyncState };
  return state.sync;
}
