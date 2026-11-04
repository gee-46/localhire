// Earlier versions stored a generated cartoon (dicebear) URL as every new user's avatar. That is not a
// photograph, so it must never be shown as a worker's "profile photo" nor satisfy the photo requirement.
const PLACEHOLDER = /(^|\/\/)([a-z0-9-]+\.)?dicebear\.com\//i;

const isPlaceholderAvatar = (url) => typeof url === 'string' && PLACEHOLDER.test(url);

// Returns the URL only if it is a real uploaded/provider photo; otherwise null.
const realAvatarUrl = (url) => (typeof url === 'string' && url && !isPlaceholderAvatar(url) ? url : null);

module.exports = { isPlaceholderAvatar, realAvatarUrl };
