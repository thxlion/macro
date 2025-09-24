'use strict';

import { getIdToken } from './auth.js';

const API_ENDPOINT = '/api/user/api-key';

async function authenticatedFetch(path, { method = 'GET', headers = {}, body, ...rest } = {}) {
  const token = await getIdToken();
  if (!token) {
    throw new Error('Authentication is required.');
  }

  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...headers
    },
    body,
    ...rest
  });

  if (response.status === 401) {
    throw new Error('Unauthorized');
  }

  return response;
}

export async function fetchRemoteApiKey() {
  try {
    const response = await authenticatedFetch(API_ENDPOINT);
    if (response.status === 204) {
      return { apiKey: null, updatedAt: null };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.message || 'Unable to load API key.');
    }
    return await response.json();
  } catch (error) {
    if (error.message === 'Unauthorized' || error.message === 'Authentication is required.') {
      return { apiKey: null, updatedAt: null };
    }
    console.warn('[sync] Failed to fetch remote API key', error);
    throw error;
  }
}

export async function storeRemoteApiKey(apiKey) {
  if (!apiKey) return;
  try {
    const response = await authenticatedFetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ apiKey })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.message || 'Unable to store API key.');
    }
  } catch (error) {
    if (error.message === 'Unauthorized' || error.message === 'Authentication is required.') {
      return;
    }
    console.warn('[sync] Failed to store remote API key', error);
    throw error;
  }
}

export async function deleteRemoteApiKey() {
  try {
    await authenticatedFetch(API_ENDPOINT, { method: 'DELETE' });
  } catch (error) {
    if (error.message === 'Unauthorized' || error.message === 'Authentication is required.') {
      return;
    }
    console.warn('[sync] Failed to delete remote API key', error);
    throw error;
  }
}
