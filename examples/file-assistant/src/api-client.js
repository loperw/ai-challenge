export async function fetchUser(userId, { signal } = {}) {
  const response = await fetch(`/api/v2/users/${encodeURIComponent(userId)}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
