# Deployment Instructions

## Architecture Overview

Email Chess uses three components:

1. **Google Apps Script (code.gs + Chess.gs)** - Manages email flow, game state, player move validation (via chess.js), and Claude commentary
2. **Google Cloud Function (Stockfish WASM)** - Runs Stockfish 16 chess engine to generate opponent moves
3. **Claude API** - Provides teaching commentary on moves (non-blocking; game works even if commentary fails)

```
Player email → GAS polls Gmail → validates move (chess.js)
  → calls Cloud Function (Stockfish) → gets engine move
  → calls Claude API → gets commentary
  → sends reply email with move + commentary
```

## Prerequisites

- Google account with Gmail and Google Sheets
- Anthropic API key ([get one here](https://console.anthropic.com))
- Google Cloud project with billing enabled
- `gcloud` CLI installed ([install guide](https://cloud.google.com/sdk/docs/install))

## Part 1: Deploy the Stockfish Cloud Function

### 1.1 Set up Google Cloud project

```bash
# Authenticate
gcloud auth login

# Create a new project (or use an existing one)
gcloud projects create email-chess --name="Email Chess"
gcloud config set project email-chess

# Enable required APIs
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
```

### 1.2 Set a billing budget alert

This is important to avoid surprise charges. Expected cost is well under $1/month for personal use.

```bash
# Go to the billing console and set a budget alert:
# https://console.cloud.google.com/billing
```

1. Navigate to **Billing** > **Budgets & alerts**
2. Click **Create budget**
3. Set the budget amount to **$5** (generous ceiling for a personal project)
4. Set alert thresholds at **50%**, **90%**, and **100%**
5. Enable email notifications

### 1.3 Deploy the function

From the `stockfish-cloud-function/` directory:

```bash
cd stockfish-cloud-function

# Deploy with IAM authentication (no public access)
gcloud functions deploy getMove \
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

After deployment, note the **URL** from the output. It will look like:
```
https://us-central1-email-chess.cloudfunctions.net/getMove
```

### 1.4 Grant your Apps Script service account invoke permission

Google Apps Script runs under your Google account's identity. You need to grant it permission to invoke the Cloud Function.

```bash
# Grant your Google account the Cloud Run Invoker role
gcloud functions add-invoker-policy-binding getMove \
  --gen2 \
  --region=us-central1 \
  --member="user:YOUR_EMAIL@gmail.com"
```

Replace `YOUR_EMAIL@gmail.com` with the Google account that owns the Apps Script project.

### 1.5 Test the deployment

```bash
# Get an access token and test the function
TOKEN=$(gcloud auth print-identity-token)

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "difficulty": "intermediate"}' \
  https://us-central1-email-chess.cloudfunctions.net/getMove
```

Expected response:
```json
{"move":"e2e4","evaluation":{"type":"cp","value":30}}
```

## Part 2: Set Up Google Apps Script

### 2.1 Create the spreadsheet and Apps Script project

1. Open [Google Sheets](https://sheets.google.com) and create a new blank spreadsheet
2. Go to **Extensions > Apps Script**
3. Delete any default code in the editor

### 2.2 Add the script files

You need to create two files in the Apps Script editor:

**File 1: Chess.gs**
1. Click the **+** next to "Files" in the left sidebar
2. Select **Script** and name it `Chess`
3. Delete any default content
4. Copy the entire contents of `Chess.gs` from this repo and paste it in
5. Save (Ctrl+S)

**File 2: Code.gs**
1. Click on the default `Code.gs` file
2. Replace all content with the contents of `code.gs` from this repo
3. Save (Ctrl+S)

### 2.3 Configure Script Properties

1. Click **Project Settings** (gear icon in left sidebar)
2. Scroll to **Script Properties**
3. Add these properties:

| Property | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `STOCKFISH_URL` | The Cloud Function URL from step 1.3 (e.g. `https://us-central1-email-chess.cloudfunctions.net/getMove`) |
| `EMAIL` | *(Optional)* Your email address. If not set, uses the account email. |

### 2.4 Configure game settings (optional)

Edit the `CONFIG` object at the top of `code.gs` to customise:

| Setting | Default | Options |
|---------|---------|---------|
| `DIFFICULTY` | `intermediate` | `beginner`, `intermediate`, `advanced` |
| `PLAYER_COLOUR` | `white` | `white`, `black` |
| `POLL_MINUTES` | `5` | Any number (minutes between email checks) |

Difficulty maps to Stockfish strength:
- **beginner**: Skill Level 3, depth 5 (~1200 Elo)
- **intermediate**: Skill Level 10, depth 10 (~1800 Elo)
- **advanced**: Skill Level 20, depth 15 (~2500+ Elo)

### 2.5 Authorize and start

1. In the Apps Script editor, select `quickStart` from the function dropdown
2. Click **Run**
3. When prompted, click **Review Permissions** and authorize the script
4. The script will:
   - Initialise the GameState sheet
   - Validate your API key and Stockfish URL
   - Set up email polling triggers
   - Start your first game

Check your inbox for the first chess email.

## Part 3: Playing the Game

### Making moves

Reply to the chess email thread with your move as the **first word**:
- `e4` - Pawn to e4
- `Nf3` - Knight to f3
- `O-O` - Castle kingside
- `Qxd7+` - Queen takes d7, check

### Commands

Type these as the first word in your reply:
- `NEW` - Start a new game
- `RESIGN` - Resign current game
- `PAUSE` - Pause the game
- `CONTINUE` - Resume after pause

### What the emails look like

Each response email contains:
- The engine's move in standard algebraic notation
- Position evaluation (how the engine assesses the position)
- Full move history
- Current FEN position
- Claude's teaching commentary (strategic explanations, tips)

## Security Notes

- The Cloud Function is deployed with **IAM authentication** — it is not publicly accessible
- GAS authenticates using `ScriptApp.getOAuthToken()` which provides an OAuth 2.0 token
- Only your Google account (and any accounts you explicitly grant `roles/run.invoker`) can call the function
- The only data sent to the Cloud Function is FEN strings (board positions) — no personal data
- The Anthropic API key is stored in GAS Script Properties (encrypted at rest by Google)

## Estimated Costs

| Component | Estimated Monthly Cost |
|-----------|----------------------|
| Cloud Function (Stockfish) | < $0.10 (2M free invocations/month) |
| Claude API (commentary) | ~$0.10-0.30 per full game |
| Google Apps Script | Free |
| Gmail / Google Sheets | Free |

**Total**: Under $1/month for casual play.

## Troubleshooting

### "STOCKFISH_URL is not set" error
- Check Script Properties in the Apps Script project settings
- Ensure the property name is exactly `STOCKFISH_URL`

### Cloud Function returns 403/401
- Verify you ran the `add-invoker-policy-binding` command (step 1.4)
- Ensure the email in the command matches the Google account running the Apps Script
- IAM changes can take a few minutes to propagate

### "Engine returned invalid move" error
- This should be rare. Check that the FEN in the GameState sheet is valid
- Try starting a new game with the `NEW` command

### Commentary missing from emails
- Commentary is non-fatal — if the Claude API fails, the game continues without it
- Check your Anthropic API key is valid and has credit
- Check the Apps Script execution log for details

### Moves not being picked up
- Verify triggers are set up: run `setupTriggers()` in the Apps Script editor
- Check that your reply is in the correct email thread
- Your move must be the first word in the reply

### Reset everything
1. Delete all triggers: run in Apps Script console:
   ```javascript
   ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t))
   ```
2. Run `quickStart()` again

## Updating the Cloud Function

If you need to update the Stockfish function later:

```bash
cd stockfish-cloud-function

gcloud functions deploy getMove \
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

## Local Testing

### Test Stockfish locally

```bash
cd stockfish-cloud-function
npm install
node test.js
```

### Test the Cloud Function HTTP server locally

```bash
cd stockfish-cloud-function
npm start
# In another terminal:
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "difficulty": "beginner"}'
```
