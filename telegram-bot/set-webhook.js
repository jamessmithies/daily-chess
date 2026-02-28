#!/usr/bin/env node
// ============================================================
// Set the Telegram webhook URL for the chess bot.
//
// Usage:
//   TELEGRAM_TOKEN=<token> WEBHOOK_URL=<url> node set-webhook.js
//
// Or set them in your environment first, then just run:
//   node set-webhook.js
// ============================================================

const token = process.env.TELEGRAM_TOKEN;
const webhookUrl = process.env.WEBHOOK_URL;
const webhookSecret = process.env.WEBHOOK_SECRET;

if (!token) {
  console.error('Error: TELEGRAM_TOKEN environment variable is required.');
  process.exit(1);
}
if (!webhookUrl) {
  console.error('Error: WEBHOOK_URL environment variable is required.');
  console.error('This should be your Cloud Function URL, e.g.:');
  console.error('  https://us-central1-YOUR_PROJECT.cloudfunctions.net/telegramWebhook');
  process.exit(1);
}

async function main() {
  const url = `https://api.telegram.org/bot${token}/setWebhook`;
  const body = { url: webhookUrl };
  if (webhookSecret) {
    body.secret_token = webhookSecret;
    console.log('Including secret_token for webhook verification.');
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (json.ok) {
    console.log('Webhook set successfully.');
    console.log(`  URL: ${webhookUrl}`);
  } else {
    console.error('Failed to set webhook:', json.description);
    process.exit(1);
  }
}

main();
