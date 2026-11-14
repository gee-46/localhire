// Prints a new VAPID key pair for Web Push. Run once, put the values in server/.env, keep the private key secret.
//   npm --prefix server run push:generate-keys
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('Add these to server/.env (the private key must never be committed or sent to a browser):\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@your-domain.example   # or an https:// URL that identifies you to push services');
