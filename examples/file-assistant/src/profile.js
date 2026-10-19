import { fetchUser } from './api-client.js';
export const loadProfile = userId => fetchUser(userId);
