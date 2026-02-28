# Telegram Chess

Play chess against Stockfish via Telegram. Claude provides optional teaching commentary after each move.

## Architecture

```
Telegram  →  Bot Cloud Function  →  Stockfish Cloud Function
                    ↓
              Claude API (commentary)
```

Two independent Google Cloud Functions:
- **`telegram-bot/`** — Handles Telegram messages, game logic, move validation (chess.js), Claude commentary. Game state stored as JSON in Cloud Storage.
- **`stockfish-cloud-function/`** — Stateless Stockfish WASM wrapper. Receives a FEN, returns a move and evaluation.

## Setup

### Prerequisites
- Google Cloud project with billing enabled (free tier is sufficient)
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated
- Node.js 22+

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow the prompts
3. Save the bot token

### 2. Create a Cloud Storage bucket

```bash
gcloud storage buckets create gs://YOUR_BUCKET_NAME --project=YOUR_PROJECT_ID --location=us-central1
```

### 3. Deploy the Stockfish function

```bash
cd stockfish-cloud-function
npm install

gcloud functions deploy getMove \
  --project=YOUR_PROJECT_ID \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=getMove \
  --trigger-http \
  --no-allow-unauthenticated \
  --memory=512MB \
  --timeout=120s
```

> **Note:** The Stockfish WASM binary requires Node.js 20 runtime. The telegram bot uses Node.js 22.

Note the URL printed after deployment (e.g. `https://us-central1-YOUR_PROJECT.cloudfunctions.net/getMove`).

### 4. Store secrets in Secret Manager

Sensitive values are stored in [Google Cloud Secret Manager](https://cloud.google.com/secret-manager) rather than as plain environment variables.

```bash
gcloud services enable secretmanager.googleapis.com --project=YOUR_PROJECT_ID

# Create secrets
echo -n "YOUR_BOT_TOKEN" | gcloud secrets create TELEGRAM_TOKEN --data-file=- --project=YOUR_PROJECT_ID
echo -n "YOUR_ANTHROPIC_KEY" | gcloud secrets create ANTHROPIC_API_KEY --data-file=- --project=YOUR_PROJECT_ID
echo -n "$(openssl rand -hex 32)" | gcloud secrets create WEBHOOK_SECRET --data-file=- --project=YOUR_PROJECT_ID

# Grant the default compute service account access
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')

for SECRET in TELEGRAM_TOKEN ANTHROPIC_API_KEY WEBHOOK_SECRET; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor" \
    --project=YOUR_PROJECT_ID
done
```

> **Note:** Save the webhook secret value — you'll need it when setting the Telegram webhook in step 6.
> You can retrieve it later with: `gcloud secrets versions access latest --secret=WEBHOOK_SECRET --project=YOUR_PROJECT_ID`

### 5. Deploy the Telegram bot function

```bash
cd telegram-bot
npm install

gcloud functions deploy telegramWebhook \
  --project=YOUR_PROJECT_ID \
  --gen2 \
  --runtime=nodejs22 \
  --region=us-central1 \
  --source=. \
  --entry-point=telegramWebhook \
  --trigger-http \
  --allow-unauthenticated \
  --memory=256MB \
  --timeout=60s \
  --set-secrets="TELEGRAM_TOKEN=TELEGRAM_TOKEN:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,WEBHOOK_SECRET=WEBHOOK_SECRET:latest" \
  --set-env-vars="STOCKFISH_URL=YOUR_STOCKFISH_URL,GCS_BUCKET=YOUR_BUCKET_NAME"
```

**Optional env vars:**
- `ALLOWED_CHAT_ID` — Restrict the bot to a single Telegram chat. To find your chat ID: temporarily remove the webhook (`curl "https://api.telegram.org/botYOUR_TOKEN/deleteWebhook"`), send a message to the bot, then call `curl "https://api.telegram.org/botYOUR_TOKEN/getUpdates"` and look for `"chat":{"id":...}`. Re-set the webhook afterwards.

### 6. Set the Telegram webhook

```bash
curl "https://api.telegram.org/botYOUR_TOKEN/setWebhook?url=https://us-central1-YOUR_PROJECT.cloudfunctions.net/telegramWebhook&secret_token=YOUR_SECRET"
```

Or using the helper script:

```bash
cd telegram-bot
TELEGRAM_TOKEN=YOUR_BOT_TOKEN \
WEBHOOK_URL=https://us-central1-YOUR_PROJECT.cloudfunctions.net/telegramWebhook \
WEBHOOK_SECRET=YOUR_SECRET \
node set-webhook.js
```

### 7. Play

Open your bot in Telegram and send `/new`.

## Bot commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new game |
| `/resign` | Resign current game |
| `/status` | Show the board |
| `/difficulty beginner\|intermediate\|advanced` | Set difficulty |
| `/help` | Show help |
| *(any text)* | Interpreted as a chess move (e.g. `e4`, `Nf3`, `O-O`) |

## Difficulty levels

| Level | Stockfish Skill | Search Depth | Approx. Elo |
|-------|----------------|--------------|--------------|
| beginner | 3 | 5 | ~1200 |
| intermediate | 10 | 10 | ~1800 |
| advanced | 20 | 15 | ~2500+ |

## Security

- **Webhook secret** — Telegram sends a secret token header with every request; the bot rejects requests without a valid token.
- **Stockfish auth** — The Stockfish function is deployed with `--no-allow-unauthenticated`. The bot authenticates using GCP ID tokens via the metadata server.
- **Chat restriction** — Optional `ALLOWED_CHAT_ID` restricts the bot to a single Telegram chat.
- **Rate limiting** — In-memory rate limiter (5 requests per 10 seconds per chat) prevents abuse.
- **HTML escaping** — All dynamic text (commentary, move history, user input) is escaped before inclusion in Telegram HTML messages.
- **Input validation** — FEN strings are validated with character whitelists and length limits. Move input is parsed via strict regex.
- **Secret Manager** — Sensitive credentials (Telegram token, Anthropic API key, webhook secret) are stored in Google Cloud Secret Manager, not as plain environment variables.
- **No secret leakage** — Error messages sent to users are generic; internal details are logged server-side only.

## Costs

Everything runs within GCP free tier for personal use:
- Cloud Functions: 2M invocations/month free
- Cloud Storage: 5GB free
- Claude Haiku commentary: ~$0.001 per move

## License

MIT License. See [LICENSE](LICENSE).
