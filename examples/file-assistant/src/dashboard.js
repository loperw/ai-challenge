import { fetchUser } from './api-client.js';
export const loadDashboard = (userId, signal) => fetchUser(userId, { signal });
