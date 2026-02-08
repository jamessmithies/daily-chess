// ============================================================
// EMAIL CHESS
// ============================================================
// Play correspondence chess against Claude via email.
// The script polls Gmail for your moves and responds with Claude's
// moves in the same thread. Fully email-driven after the first game.
//
// Commands (must be the first word in your reply):
//   NEW       — start a new game
//   RESIGN    — resign the current game
//   PAUSE     — pause the game
//   CONTINUE  — resume after a pause
//
// Quick Setup:
//   1. Create a Google Sheet → Extensions → Apps Script → paste this
//   2. Project Settings → Script Properties:
//        ANTHROPIC_API_KEY  — your key from console.anthropic.com
//        EMAIL              — your email address (optional; defaults
//                             to your Google account email)
//   3. (Optional) Edit CONFIG defaults below (difficulty, color, etc.)
//   4. Run quickStart() — this does everything in one step!
//
// Manual Setup (if you prefer step-by-step):
//   1-2. Same as above
//   3. Run initialiseSheet()
//   4. Run setupTriggers()
//   5. Run startFirstGame()
// ============================================================

// --- SECURITY CONFIGURATION ---
const SECURITY_CONFIG = {
  // Enable security features
  ENABLE_AUDIT_LOGGING: true,
  ENABLE_STRICT_VALIDATION: true,

  // Rate limiting
  MAX_MOVES_PER_HOUR: 20,
  MAX_COMMANDS_PER_DAY: 50,
  MAX_FAILED_ATTEMPTS_PER_HOUR: 5,
  LOCKOUT_DURATION_MS: 3600000, // 1 hour

  // Input constraints
  MAX_INPUT_LENGTH: 100,

  // A permissive-but-structured SAN-ish pattern (first token only)
  // Supports: O-O/O-O-O, piece moves with optional disambiguation, captures,
  // pawn moves/captures, promotions, and optional +/# at end.
  // NOTE: legality is still enforced by Claude; this is format gating.
  SAN_PATTERN: /^(O-O-O|O-O|[KQRBN](?:[a-h]|[1-8])?x?[a-h][1-8](?:=[QRBN])?|[a-h]x?[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?)([+#])?$/,

  ALLOWED_COMMANDS: ['NEW', 'RESIGN', 'PAUSE', 'CONTINUE'],

  // Audit retention (prevents Script Properties bloat)
  AUDIT_MAX_ENTRIES: 80,
  AUDIT_MAX_AGE_DAYS: 14,
};

// --- CONFIGURATION ---
const CONFIG = {
  ANTHROPIC_API_KEY: PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'),
  EMAIL: PropertiesService.getScriptProperties().getProperty('EMAIL'),
  DIFFICULTY: 'intermediate',   // beginner | intermediate | advanced
  PLAYER_COLOUR: 'white',       // white | black
  POLL_MINUTES: 5,              // How often to check for email replies
  MODEL: 'claude-sonnet-4-5-20250929',
  THREAD_LABEL: 'chess-claude', // Gmail label to track the game thread
  AUTO_ARCHIVE: true,           // Automatically archive threads (remove from inbox)

  MAX_MOVE_LEN: 20,
  MAX_FEN_LEN: 200,
  MAX_COMMENT_LEN: 1500,
  MAX_MOVEHIST_LEN: 6000,

  // Claude call controls
  MIN_CLAUDE_CALL_MS: 2000,      // Minimum time between API calls
  INTER_CALL_DELAY_MS: 1200,     // Delay between validation and response calls

  // Token budgets (responses are tiny JSON)
  MAX_TOKENS_CLAUDE_MOVE: 220,
  MAX_TOKENS_VALIDATE_MOVE: 220,

  // Simple spend control
  MAX_CLAUDE_CALLS_PER_DAY: 200,
};

const NOTATION_GUIDE = `
---
Algebraic notation quick reference:

Pieces:  K = King, Q = Queen, R = Rook, B = Bishop, N = Knight
         (pawns have no letter — just the square, e.g. e4)
Moves:   Nf3 = knight to f3, Bb5 = bishop to b5
Capture: Nxe5 = knight captures on e5, exd5 = pawn captures on d5
Castle:  O-O = kingside, O-O-O = queenside
Promote: e8=Q = pawn promotes to queen
Check:   + (e.g. Qd7+)  Checkmate: # (e.g. Qf7#)

If two pieces can reach the same square, add the file or rank:
  Rae1 = rook on a-file to e1, R1e2 = rook on rank 1 to e2
`;

// --- SECURITY HELPERS ---

function nowIso_() {
  return new Date().toISOString();
}

function todayKey_() {
  // YYYY-MM-DD in script TZ
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function hourKey_() {
  // YYYY-MM-DD-HH in script TZ
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HH');
}

function redact_(value) {
  const s = String(value ?? '');
  if (s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

function pruneAudit_() {
  const props = PropertiesService.getScriptProperties();
  const keys = props.getKeys();

  const auditKeys = [];
  for (const k of keys) {
    if (k.startsWith('AUDIT_')) auditKeys.push(k);
  }
  if (auditKeys.length === 0) return;

  // Parse timestamps from keys (AUDIT_<millis>)
  auditKeys.sort((a, b) => {
    const ta = parseInt(a.slice('AUDIT_'.length), 10) || 0;
    const tb = parseInt(b.slice('AUDIT_'.length), 10) || 0;
    return tb - ta; // newest first
  });

  // Age-based pruning
  const maxAgeMs = SECURITY_CONFIG.AUDIT_MAX_AGE_DAYS * 24 * 3600 * 1000;
  const now = Date.now();
  for (const k of auditKeys) {
    const t = parseInt(k.slice('AUDIT_'.length), 10) || 0;
    if (t && now - t > maxAgeMs) props.deleteProperty(k);
  }

  // Count-based pruning (keep newest N)
  const remaining = auditKeys
    .filter(k => props.getProperty(k) != null)
    .sort((a, b) => (parseInt(b.slice(6), 10) || 0) - (parseInt(a.slice(6), 10) || 0));

  if (remaining.length > SECURITY_CONFIG.AUDIT_MAX_ENTRIES) {
    for (let i = SECURITY_CONFIG.AUDIT_MAX_ENTRIES; i < remaining.length; i++) {
      props.deleteProperty(remaining[i]);
    }
  }
}

/**
 * Audit logging for security events
 * - Logs to execution log via console.log
 * - Persists only ERROR/CRITICAL to Script Properties (bounded by retention)
 * - Avoids persisting sensitive details (token, API key)
 */
function auditLog(event, details, severity = 'INFO') {
  if (!SECURITY_CONFIG.ENABLE_AUDIT_LOGGING) return;

  const safeDetails = details || {};
  const log = {
    timestamp: nowIso_(),
    event,
    severity,
    details: safeDetails,
  };

  console.log(JSON.stringify(log));

  if (severity === 'CRITICAL' || severity === 'ERROR') {
    const props = PropertiesService.getScriptProperties();
    const auditKey = 'AUDIT_' + Date.now();
    props.setProperty(auditKey, JSON.stringify(log));
    pruneAudit_();
  }
}

/**
 * Check for rate limit violations (fixed windows):
 * - MOVE: per-hour counter
 * - FAILED: per-hour counter
 * - COMMAND: per-day counter
 * Lockout applies per identifier.
 */
function checkRateLimit(type, identifier) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();

  // Check lockout
  const lockoutKey = `LOCKOUT_${identifier}`;
  const lockoutUntil = parseInt(props.getProperty(lockoutKey) || '0', 10);
  if (lockoutUntil > now) {
    auditLog('RATE_LIMIT_LOCKOUT', { type, identifier }, 'WARNING');
    throw new Error('Account temporarily locked due to suspicious activity. Please try again later.');
  }

  // Bucket keys by window
  let bucket;
  let limit;

  switch (type) {
    case 'MOVE':
      bucket = hourKey_();
      limit = SECURITY_CONFIG.MAX_MOVES_PER_HOUR;
      break;
    case 'FAILED':
      bucket = hourKey_();
      limit = SECURITY_CONFIG.MAX_FAILED_ATTEMPTS_PER_HOUR;
      break;
    case 'COMMAND':
      bucket = todayKey_();
      limit = SECURITY_CONFIG.MAX_COMMANDS_PER_DAY;
      break;
    default:
      bucket = hourKey_();
      limit = 10;
      break;
  }

  const attemptKey = `ATTEMPTS_${type}_${identifier}_${bucket}`;
  const attempts = parseInt(props.getProperty(attemptKey) || '0', 10) + 1;
  props.setProperty(attemptKey, String(attempts));

  if (attempts > limit) {
    props.setProperty(lockoutKey, String(now + SECURITY_CONFIG.LOCKOUT_DURATION_MS));
    auditLog('RATE_LIMIT_EXCEEDED', { type, identifier, attempts, limit }, 'CRITICAL');
    throw new Error('Rate limit exceeded. Please try again later.');
  }

  return attempts;
}

/**
 * Sanitize input (for email/user-visible fields).
 * NOTE: Do not over-sanitize structured fields (like FEN) beyond trimming/length,
 * because it can silently change meaning. Use format validators instead.
 */
function sanitizeInput(input, maxLength = SECURITY_CONFIG.MAX_INPUT_LENGTH) {
  if (typeof input !== 'string') return '';
  let sanitized = input.replace(/[\x00-\x1F\x7F-\x9F]/g, ''); // control chars
  // Strip HTML-ish tags (mostly to keep logs/emails clean)
  sanitized = sanitized.replace(/<[^>]*>/g, '');
  if (sanitized.length > maxLength) sanitized = sanitized.substring(0, maxLength);
  return sanitized.trim();
}

/**
 * Validate chess move format (SAN-ish).
 * We only accept "first token only" moves, and then Claude validates legality.
 */
function validateMovePattern(move) {
  if (!SECURITY_CONFIG.ENABLE_STRICT_VALIDATION) return true;
  const m = String(move || '').trim();
  if (!m) return false;
  if (m.length > CONFIG.MAX_MOVE_LEN) return false;
  return SECURITY_CONFIG.SAN_PATTERN.test(m);
}

// --- UTIL HELPERS ---
function getAccountEmail() {
  const e = (Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!e) {
    auditLog('EMAIL_ERROR', { msg: 'Could not determine account email' }, 'ERROR');
    throw new Error('Configuration error. Could not determine account email.');
  }
  return e;
}

function getDestinationEmail() {
  const e = (CONFIG.EMAIL || Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!e) {
    auditLog('EMAIL_ERROR', { msg: 'Destination email not set' }, 'ERROR');
    throw new Error('Configuration error. Destination email not set.');
  }
  return e;
}

function normalizeEmail(fromField) {
  const s = String(fromField || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/**
 * Enhanced sender verification:
 * - Header-based allowlist (must match effective user email)
 * - Thread verification: ensure thread has at least one from:me message around that date
 *   (lightweight extra check; not cryptographic)
 */
function onlyMeGuard(message, thread) {
  const allowed = getAccountEmail();
  const sender = normalizeEmail(message.getFrom());

  if (sender !== allowed) {
    auditLog('SENDER_MISMATCH', { sender, allowed }, 'WARNING');
    return false;
  }

  try {
    if (thread && thread.getId) {
      const id = thread.getId();
      const d = message.getDate();
      const after = Utilities.formatDate(
        new Date(d.getTime() - 86400000),
        Session.getScriptTimeZone(),
        'yyyy/MM/dd'
      );
      const q = `in:anywhere thread:${id} from:me after:${after}`;
      const hits = GmailApp.search(q, 0, 1);
      if (!hits || hits.length === 0) {
        auditLog('THREAD_VERIFICATION_FAILED', { threadId: id }, 'WARNING');
        return false;
      }
    }
  } catch (e) {
    auditLog('THREAD_VERIFICATION_ERROR', { error: String(e) }, 'ERROR');
    if (thread) return false;
  }

  return true;
}

function withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    auditLog('LOCK_TIMEOUT', { error: String(e) }, 'ERROR');
    throw new Error('System busy. Please try again.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function enforceRateLimit(propertyKey, minMs) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const last = parseInt(props.getProperty(propertyKey) || '0', 10);
  if (last && now - last < minMs) {
    auditLog('API_RATE_LIMITED', { propertyKey, waitMs: minMs - (now - last) }, 'WARNING');
    throw new Error('Please wait briefly before trying again.');
  }
  props.setProperty(propertyKey, String(now));
}

/**
 * Game token:
 * - Use URL-safe token for Gmail subjects/search.
 * - Do NOT log token.
 */
function getOrCreateGameToken() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('CHESS_GAME_TOKEN');
  if (!token) {
    // Use UUID (sufficient) and make it compact + URL-safe
    token = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('CHESS_GAME_TOKEN', token);
    auditLog('GAME_TOKEN_CREATED', { token: redact_(token) }, 'INFO');
  }
  return token;
}

function buildSubject(prefix) {
  const token = getOrCreateGameToken();
  return `${prefix} [chess:${token}]`;
}

function safeTrim(s, maxLen) {
  const str = String(s ?? '');
  if (str.length > maxLen) return str.slice(0, maxLen);
  return str;
}

function isValidFen(fen) {
  if (typeof fen !== 'string') return false;
  fen = fen.trim();
  if (!fen || fen.length > CONFIG.MAX_FEN_LEN) return false;

  const parts = fen.split(/\s+/);
  if (parts.length < 4) return false;

  const board = parts[0];
  const toMove = parts[1];
  const castling = parts[2];
  const ep = parts[3];

  if (toMove !== 'w' && toMove !== 'b') return false;
  if (castling !== '-') {
    if (!/^[KQkq]{1,4}$/.test(castling)) return false;
    if (new Set(castling.split('')).size !== castling.length) return false;
  }
  if (!(ep === '-' || /^[a-h][36]$/.test(ep))) return false;

  const ranks = board.split('/');
  if (ranks.length !== 8) return false;

  let whiteKings = 0;
  let blackKings = 0;

  for (const r of ranks) {
    let count = 0;
    for (const ch of r) {
      if (ch >= '1' && ch <= '8') count += parseInt(ch, 10);
      else if ('pnbrqkPNBRQK'.includes(ch)) {
        count += 1;
        if (ch === 'K') whiteKings++;
        if (ch === 'k') blackKings++;
      } else return false;
    }
    if (count !== 8) return false;
  }

  if (whiteKings !== 1 || blackKings !== 1) {
    auditLog('INVALID_FEN_KINGS', { whiteKings, blackKings }, 'WARNING');
    return false;
  }

  return true;
}

// --- API BUDGET HELPERS ---
function bumpClaudeDailyCount_() {
  const props = PropertiesService.getScriptProperties();
  const key = 'CHESS_CLAUDE_COUNT_' + todayKey_();
  const count = parseInt(props.getProperty(key) || '0', 10) + 1;
  props.setProperty(key, String(count));
  if (count > CONFIG.MAX_CLAUDE_CALLS_PER_DAY) {
    auditLog('CLAUDE_DAILY_LIMIT_EXCEEDED', { count }, 'ERROR');
    throw new Error('Daily API limit reached. Try again tomorrow.');
  }
  return count;
}

// --- SHEET HELPERS ---
function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('GameState');
}

function getGameState() {
  const sheet = getSheet();
  return {
    fen: sheet.getRange('B1').getValue() || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveHistory: sheet.getRange('B2').getValue() || '',
    gameActive: sheet.getRange('B3').getValue() !== false,
    moveNumber: parseInt(sheet.getRange('B4').getValue(), 10) || 1,
    difficulty: sheet.getRange('B5').getValue() || CONFIG.DIFFICULTY,
    playerColour: sheet.getRange('B6').getValue() || CONFIG.PLAYER_COLOUR,
    threadId: sheet.getRange('B7').getValue() || '',
    lastProcessedCount: parseInt(sheet.getRange('B8').getValue(), 10) || 0,
    paused: sheet.getRange('B9').getValue() === true,
  };
}

function saveGameState(state) {
  const sheet = getSheet();

  if (!isValidFen(state.fen)) {
    auditLog('INVALID_STATE_SAVE_ATTEMPT', { fen: String(state.fen).slice(0, 80) }, 'ERROR');
    throw new Error('Invalid game state');
  }

  sheet.getRange('B1').setValue(state.fen);
  sheet.getRange('B2').setValue(safeTrim(state.moveHistory, CONFIG.MAX_MOVEHIST_LEN));
  sheet.getRange('B3').setValue(state.gameActive);
  sheet.getRange('B4').setValue(state.moveNumber);
  sheet.getRange('B5').setValue(state.difficulty);
  sheet.getRange('B6').setValue(state.playerColour);
  sheet.getRange('B7').setValue(state.threadId);
  sheet.getRange('B8').setValue(state.lastProcessedCount);
  sheet.getRange('B9').setValue(state.paused);
}

// --- INITIALISE ---
function initialiseSheet() {
  auditLog('SHEET_INIT_START', {}, 'INFO');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('GameState');
  if (!sheet) sheet = ss.insertSheet('GameState');

  sheet.getRange('A1').setValue('FEN');
  sheet.getRange('A2').setValue('Move History');
  sheet.getRange('A3').setValue('Game Active');
  sheet.getRange('A4').setValue('Move Number');
  sheet.getRange('A5').setValue('Difficulty');
  sheet.getRange('A6').setValue('Player Colour');
  sheet.getRange('A7').setValue('Thread ID');
  sheet.getRange('A8').setValue('Last Processed Msg Count');
  sheet.getRange('A9').setValue('Paused');

  const state = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveHistory: '',
    gameActive: true,
    moveNumber: 1,
    difficulty: CONFIG.DIFFICULTY,
    playerColour: CONFIG.PLAYER_COLOUR,
    threadId: '',
    lastProcessedCount: 0,
    paused: false,
  };
  saveGameState(state);

  let label = GmailApp.getUserLabelByName(CONFIG.THREAD_LABEL);
  if (!label) label = GmailApp.createLabel(CONFIG.THREAD_LABEL);

  getOrCreateGameToken();

  auditLog('SHEET_INIT_COMPLETE', {}, 'INFO');
  Logger.log('Sheet initialised. Run setupTriggers() next.');
}

// --- PREFLIGHT CHECK ---
function validateApiKey() {
  const key = CONFIG.ANTHROPIC_API_KEY;
  if (!key || key === 'YOUR_API_KEY_HERE' || String(key).trim() === '') {
    auditLog('API_KEY_MISSING', {}, 'ERROR');
    throw new Error('API key not configured. Please check settings.');
  }

  // NOTE: Key formats can change; keep only a very light check.
  if (String(key).length < 20) {
    auditLog('API_KEY_SUSPICIOUS', {}, 'WARNING');
  }

  const url = 'https://api.anthropic.com/v1/messages';
  const payload = {
    model: CONFIG.MODEL,
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Reply with the word "ok".' }],
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();

  if (code === 401) {
    auditLog('API_KEY_UNAUTHORIZED', {}, 'ERROR');
    throw new Error('API key invalid or expired.');
  }
  if (code === 403) {
    auditLog('API_KEY_FORBIDDEN', {}, 'ERROR');
    throw new Error('API key access denied.');
  }
  if (code === 429) {
    auditLog('API_RATE_LIMITED', {}, 'WARNING');
    throw new Error('API rate limited. Try again later.');
  }
  if (code >= 500) {
    auditLog('API_SERVER_ERROR', { code }, 'WARNING');
    Logger.log('API server error during validation. Proceeding with caution.');
    return true;
  }
  if (code >= 200 && code < 300) {
    auditLog('API_KEY_VALIDATED', {}, 'INFO');
    Logger.log('API key validated successfully.');
    return true;
  }

  auditLog('API_UNEXPECTED_RESPONSE', { code }, 'ERROR');
  throw new Error('Unexpected API response.');
}

function preflight() {
  Logger.log('Account email (sender allowlist): ' + getAccountEmail());
  Logger.log('Destination email: ' + getDestinationEmail());
  validateApiKey();
  auditLog('PREFLIGHT_COMPLETE', {}, 'INFO');
  Logger.log('Preflight passed. Ready to play.');
}

// --- CLAUDE API ---
function callClaude(systemPrompt, userMessage, maxTokens) {
  bumpClaudeDailyCount_();
  enforceRateLimit('CHESS_LAST_CLAUDE_CALL_MS', CONFIG.MIN_CLAUDE_CALL_MS);

  // IMPORTANT: Don't "sanitize away meaning" from structured prompts.
  // We do only a conservative trim/limit.
  userMessage = safeTrim(String(userMessage ?? ''), 5000);

  const url = 'https://api.anthropic.com/v1/messages';
  const payload = {
    model: CONFIG.MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    temperature: 0.3,
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    auditLog('CLAUDE_PARSE_ERROR', { code, error: String(e) }, 'ERROR');
    throw new Error('API communication error.');
  }

  if (code < 200 || code >= 300) {
    const msg = (json && json.error && json.error.message) ? json.error.message : `HTTP ${code}`;
    auditLog('CLAUDE_API_ERROR', { code, message: msg }, 'ERROR');
    throw new Error('API error. Please try again.');
  }

  if (json.error) {
    auditLog('CLAUDE_RESPONSE_ERROR', { error: json.error.message }, 'ERROR');
    throw new Error('API processing error.');
  }

  if (!json.content || !json.content[0] || typeof json.content[0].text !== 'string') {
    auditLog('CLAUDE_INVALID_RESPONSE', {}, 'ERROR');
    throw new Error('Invalid API response.');
  }

  return json.content[0].text;
}

function getChessSystemPrompt(state) {
  const difficultyInstructions = {
    beginner: 'Play at a beginner level. Make occasional inaccuracies. Prioritise simple, instructive positions. After your move, briefly explain what the move does in plain language.',
    intermediate: 'Play at a solid club level. Make principled moves but do not play engine-perfect lines. After your move, give a brief positional or tactical comment.',
    advanced: 'Play at the strongest level you can. After your move, give concise analytical commentary.',
  };

  return `You are a chess engine and tutor. You are playing ${state.playerColour === 'white' ? 'black' : 'white'}.

CRITICAL RULES:
- You MUST respond with EXACTLY this JSON format, no markdown fencing, no other text:
{"move":"<move>","fen":"<updated FEN>","comment":"<comment>","gameOver":<bool>,"result":"<result>"}
- The move MUST be in standard algebraic notation ONLY
- The FEN MUST be valid and represent the position after your move
- NEVER include any text outside the JSON object
- NEVER use markdown code fences
- Validate that your move is legal in the given position

DIFFICULTY: ${difficultyInstructions[state.difficulty] || difficultyInstructions.intermediate}

Respond ONLY with the JSON object.`;
}

// --- BOARD RENDERING ---
function generateTextBoard(fen) {
  const ranks = fen.split(' ')[0].split('/');
  let board = '';

  for (let i = 0; i < 8; i++) {
    const rankNum = 8 - i;
    let row = rankNum + ' ';
    const rank = ranks[i];

    for (let j = 0; j < rank.length; j++) {
      const ch = rank[j];
      if (ch >= '1' && ch <= '8') {
        for (let k = 0; k < parseInt(ch, 10); k++) row += '. ';
      } else {
        row += ch + ' ';
      }
    }
    board += row + '\n';
  }
  board += '  a b c d e f g h\n';
  return board;
}

// --- CORE GAME LOGIC ---
function parseClaudeJson(responseText) {
  // STRICT: only allow raw JSON (optionally wrapped in ```json fences)
  const cleaned = String(responseText || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    auditLog('CLAUDE_JSON_PARSE_FAILED', { sample: safeTrim(cleaned, 200) }, 'ERROR');
    throw new Error('Invalid response format');
  }

  if (!parsed || typeof parsed !== 'object') {
    auditLog('CLAUDE_INVALID_OBJECT', {}, 'ERROR');
    throw new Error('Invalid response structure');
  }

  const move = safeTrim(parsed.move, CONFIG.MAX_MOVE_LEN);
  const fen = safeTrim(parsed.fen, CONFIG.MAX_FEN_LEN);
  const comment = safeTrim(parsed.comment, CONFIG.MAX_COMMENT_LEN);
  const gameOver = Boolean(parsed.gameOver);
  const result = safeTrim(parsed.result, 200);

  if (!move || typeof move !== 'string' || !validateMovePattern(move)) {
    auditLog('CLAUDE_INVALID_MOVE', { move }, 'ERROR');
    throw new Error('Invalid move received');
  }

  if (!fen || !isValidFen(fen)) {
    auditLog('CLAUDE_INVALID_FEN', { fen: safeTrim(fen, 80) }, 'ERROR');
    throw new Error('Invalid position received');
  }

  return { move, fen, comment, gameOver, result };
}

function getClaudeMove() {
  const state = getGameState();
  if (!state.gameActive) return null;

  const systemPrompt = getChessSystemPrompt(state);
  const userMessage =
    `Current FEN: ${state.fen}\nMove history: ${state.moveHistory || '(game start)'}\nIt is your turn.`;

  const responseText = callClaude(systemPrompt, userMessage, CONFIG.MAX_TOKENS_CLAUDE_MOVE);

  let parsed;
  try {
    parsed = parseClaudeJson(responseText);
  } catch (e) {
    Logger.log('Failed to parse Claude response: ' + String(e));
    throw new Error('Unable to process move. Please try again.');
  }

  const claudeColour = state.playerColour === 'white' ? 'black' : 'white';
  const movePrefix = claudeColour === 'white' ? state.moveNumber + '.' : state.moveNumber + '...';

  state.fen = parsed.fen;
  state.moveHistory = safeTrim(
    (state.moveHistory ? state.moveHistory + ' ' : '') + movePrefix + parsed.move,
    CONFIG.MAX_MOVEHIST_LEN
  );

  if (claudeColour === 'black') state.moveNumber++;
  if (parsed.gameOver) state.gameActive = false;

  saveGameState(state);
  auditLog('CLAUDE_MOVE', { move: parsed.move }, 'INFO');
  return parsed;
}

function processPlayerMove(moveStr) {
  const state = getGameState();
  const email = getAccountEmail();

  if (!state.gameActive) return { error: 'No active game. Reply NEW to start one.' };

  moveStr = sanitizeInput(String(moveStr || '').trim(), CONFIG.MAX_MOVE_LEN);
  if (!moveStr) return { error: 'Empty move. Reply with a move like Nf3 or e4.' };

  // Rate limit: MOVE
  try {
    checkRateLimit('MOVE', email);
  } catch (e) {
    auditLog('RATE_LIMIT_MOVE', { error: String(e) }, 'WARNING');
    return { error: String(e.message || e) };
  }

  // Format gate
  if (!validateMovePattern(moveStr)) {
    try {
      checkRateLimit('FAILED', email);
    } catch (e) {
      auditLog('RATE_LIMIT_FAILED', { error: String(e) }, 'WARNING');
      return { error: String(e.message || e) };
    }
    auditLog('INVALID_MOVE_PATTERN', { move: moveStr }, 'WARNING');
    return { error: 'Invalid move format. Use standard algebraic notation (e.g., Nf3, exd5, O-O, e8=Q).' };
  }

  const systemPrompt = `You are a chess position manager. The player is playing ${state.playerColour}.

TASK: Validate the player's move and return the updated position.
- If the move is legal, return: {"valid":true,"fen":"<updated FEN>","move":"<standardised algebraic notation>"}
- If the move is illegal, return: {"valid":false,"reason":"<why it is illegal>"}

Respond ONLY with the JSON object, no markdown fencing.`;

  // Minimize injection surface: only FEN + move token
  const userMessage = `Current FEN: ${state.fen}\nPlayer's move: ${moveStr}`;

  const responseText = callClaude(systemPrompt, userMessage, CONFIG.MAX_TOKENS_VALIDATE_MOVE);

  let parsed;
  try {
    const cleaned = String(responseText || '')
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    auditLog('MOVE_VALIDATION_PARSE_ERROR', { error: String(e) }, 'ERROR');
    return { error: 'Failed to process move. Try again.' };
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.valid !== 'boolean') {
    auditLog('MOVE_VALIDATION_BAD_SHAPE', {}, 'ERROR');
    return { error: 'Failed to process move. Try again.' };
  }

  if (!parsed.valid) {
    try {
      checkRateLimit('FAILED', email);
    } catch (e) {
      auditLog('RATE_LIMIT_FAILED', { error: String(e) }, 'WARNING');
      return { error: String(e.message || e) };
    }
    auditLog('ILLEGAL_MOVE', { move: moveStr, reason: safeTrim(parsed.reason, 120) }, 'WARNING');
    return { error: 'Illegal move: ' + safeTrim(parsed.reason, 200) };
  }

  const nextFen = safeTrim(parsed.fen, CONFIG.MAX_FEN_LEN);
  const stdMove = safeTrim(parsed.move, CONFIG.MAX_MOVE_LEN);

  if (!isValidFen(nextFen)) {
    auditLog('MOVE_VALIDATION_INVALID_FEN', { fen: safeTrim(nextFen, 80) }, 'ERROR');
    return { error: 'Move processing error. Try again.' };
  }

  if (!stdMove || !validateMovePattern(stdMove)) {
    auditLog('MOVE_VALIDATION_INVALID_MOVE', { move: stdMove }, 'ERROR');
    return { error: 'Move processing error. Try again.' };
  }

  const movePrefix = state.playerColour === 'white' ? state.moveNumber + '.' : state.moveNumber + '...';
  state.fen = nextFen;
  state.moveHistory = safeTrim(
    (state.moveHistory ? state.moveHistory + ' ' : '') + movePrefix + stdMove,
    CONFIG.MAX_MOVEHIST_LEN
  );
  if (state.playerColour === 'black') state.moveNumber++;

  saveGameState(state);
  auditLog('PLAYER_MOVE', { move: stdMove }, 'INFO');
  return { success: true, move: stdMove, fen: nextFen };
}

// --- EMAIL ---
function sendGameEmail(subjectPrefix, body) {
  const state = getGameState();
  const subject = buildSubject(subjectPrefix);

  if (state.threadId) {
    const thread = GmailApp.getThreadById(state.threadId);
    if (thread) {
      thread.reply(body);

      // Ensure label is applied to the thread
      let label = GmailApp.getUserLabelByName(CONFIG.THREAD_LABEL);
      if (!label) label = GmailApp.createLabel(CONFIG.THREAD_LABEL);
      thread.addLabel(label);

      state.lastProcessedCount = thread.getMessageCount();
      saveGameState(state);
      return;
    }
  }

  GmailApp.sendEmail(getDestinationEmail(), subject, body);

  Utilities.sleep(2000);

  const token = getOrCreateGameToken();
  const q = `from:me to:${getDestinationEmail()} subject:"[chess:${token}]" newer_than:7d`;
  let threads = GmailApp.search(q, 0, 10);
  if (threads.length === 0) {
    Utilities.sleep(2000);
    threads = GmailApp.search(q, 0, 10);
  }

  if (threads.length > 0) {
    let newest = threads[0];
    for (const t of threads) {
      if (t.getLastMessageDate() > newest.getLastMessageDate()) newest = t;
    }

    state.threadId = newest.getId();
    state.lastProcessedCount = newest.getMessageCount();

    let label = GmailApp.getUserLabelByName(CONFIG.THREAD_LABEL);
    if (!label) label = GmailApp.createLabel(CONFIG.THREAD_LABEL);
    newest.addLabel(label);

    saveGameState(state);
  }
}

function buildMoveEmail(claudeResponse) {
  const state = getGameState();

  let body = `Claude plays: ${claudeResponse.move}\n\n`;
  body += `${claudeResponse.comment}\n\n`;
  body += `Move history: ${state.moveHistory}\n\n`;

  if (claudeResponse.gameOver) {
    body += `Game over: ${claudeResponse.result}\n\n`;
    body += `Reply NEW to start a new game.\n`;
  } else {
    body += `Reply with your move (e.g. Nf3, O-O, e4).\n`;
    body += `Reply NEW to start a new game.\n`;
    body += `Reply RESIGN to resign.\n`;
    body += `Reply PAUSE to pause the game.\n`;
  }

  body += NOTATION_GUIDE;
  return safeTrim(body, 20000);
}

// --- REPLY PARSING ---
function extractMoveFromReply(messageBody) {
  const lines = String(messageBody || '').split('\n');

  const freshLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('>')) break;
    if (line.startsWith('On ') && line.includes(' wrote:')) break;
    if (line === '--') break;
    if (line.match(/^-{3,}$/)) break;
    if (line.startsWith('From:')) break;
    freshLines.push(line);
  }

  const freshText = freshLines.join(' ').trim();
  if (!freshText) return null;

  // Skip automated emails sent by the script itself
  const skipPrefixes = [
    'Claude plays:',
    'Your move:',
    'New game!',
    'You resigned.',
    'Game paused.',
    'Game resumed!',
    "It's your move!",
    'No active game.',
    'Illegal move:',
  ];
  for (const p of skipPrefixes) {
    if (freshText.startsWith(p)) return null;
  }

  const firstTokenRaw = freshText.split(/\s+/)[0];
  const firstToken = firstTokenRaw.toUpperCase();

  if (SECURITY_CONFIG.ALLOWED_COMMANDS.includes(firstToken)) {
    return { command: firstToken.toLowerCase() };
  }

  if (validateMovePattern(firstTokenRaw)) {
    return { move: firstTokenRaw };
  }

  return null;
}

// --- POLL FOR REPLIES ---
function checkForReplies() {
  return withScriptLock(() => {
    const state = getGameState();
    if (!state.threadId) return;

    const thread = GmailApp.getThreadById(state.threadId);
    if (!thread) return;

    const messages = thread.getMessages();
    const startIdx = Math.max(0, state.lastProcessedCount);
    if (messages.length <= startIdx) return;

    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i];

      if (!onlyMeGuard(msg, thread)) {
        Logger.log('Rejected reply from unauthorized sender: ' + msg.getFrom());
        continue;
      }

      const parsed = extractMoveFromReply(msg.getPlainBody());
      if (!parsed) continue;

      // Mark as processed early to avoid re-processing on retries
      state.lastProcessedCount = i + 1;
      saveGameState(state);

      // Commands are "cheap" but still rate-limited per day
      if (parsed.command) {
        try {
          checkRateLimit('COMMAND', getAccountEmail());
        } catch (e) {
          sendGameEmail('♟ Chess', String(e.message || e));
          return;
        }
      }

      if (parsed.command === 'new') {
        startNewGameInternal_();
        return;
      }

      if (parsed.command === 'resign') {
        state.gameActive = false;
        saveGameState(state);
        sendGameEmail(
          '♟ Chess',
          'You resigned. Good game!\n\n' +
            'Move history: ' + state.moveHistory +
            '\n\nReply NEW to start a new game.'
        );
        if (CONFIG.AUTO_ARCHIVE) thread.moveToArchive();
        return;
      }

      if (parsed.command === 'pause') {
        state.paused = true;
        saveGameState(state);
        sendGameEmail('♟ Chess', 'Game paused. The game will wait for your next move.\n\nReply CONTINUE to resume.');
        if (CONFIG.AUTO_ARCHIVE) thread.moveToArchive();
        return;
      }

      if (parsed.command === 'continue') {
        state.paused = false;
        saveGameState(state);
        sendGameEmail(
          '♟ Chess',
          'Game resumed!\n\n' +
            'Move history: ' + state.moveHistory +
            '\n\nReply with your move.'
        );
        if (CONFIG.AUTO_ARCHIVE) thread.moveToArchive();
        return;
      }

      if (state.paused) {
        sendGameEmail('♟ Chess', 'Game is paused. Reply CONTINUE to resume, or NEW to start a fresh game.');
        if (CONFIG.AUTO_ARCHIVE) thread.moveToArchive();
        return;
      }

      if (parsed.move) {
        const result = processPlayerMove(parsed.move);
        if (result.error) {
          const cur = getGameState();
          sendGameEmail(
            '♟ Chess',
            result.error +
              '\n\nMove history: ' + cur.moveHistory +
              '\n\nTry again — reply with a valid move (as the first word).'
          );
          return; // keep visible on errors
        }

        Utilities.sleep(CONFIG.INTER_CALL_DELAY_MS);

        const claudeResult = getClaudeMove();
        if (claudeResult) {
          const emailBody = 'Your move: ' + result.move + '\n\n' + buildMoveEmail(claudeResult);
          sendGameEmail('♟ Chess', emailBody);
          if (CONFIG.AUTO_ARCHIVE) thread.moveToArchive();
        }
        return;
      }
    }

    state.lastProcessedCount = messages.length;
    saveGameState(state);
  });
}

// --- NEW GAME ---
// Internal version — no lock. Called from within locked contexts.
function startNewGameInternal_(difficulty, colour) {
  const diff = difficulty || CONFIG.DIFFICULTY;
  const col = colour || CONFIG.PLAYER_COLOUR;

  PropertiesService.getScriptProperties().deleteProperty('CHESS_GAME_TOKEN');

  const state = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveHistory: '',
    gameActive: true,
    moveNumber: 1,
    difficulty: diff,
    playerColour: col,
    threadId: '',
    lastProcessedCount: 0,
    paused: false,
  };
  saveGameState(state);

  if (col === 'black') {
    const claudeResult = getClaudeMove();
    if (claudeResult) {
      let body = `New game! You are black. Difficulty: ${diff}.\n\n`;
      body += buildMoveEmail(claudeResult);
      body += NOTATION_GUIDE;
      sendGameEmail('♟ New Chess Game', body);
    }
  } else {
    let body = `New game! You are white. Difficulty: ${diff}.\n\n`;
    body += `Reply with your opening move (e.g. e4, d4, Nf3).\n`;
    body += NOTATION_GUIDE;
    sendGameEmail('♟ New Chess Game', body);
  }
}

// Public entry point — acquires lock.
function startNewGameViaEmail(difficulty, colour) {
  return withScriptLock(() => startNewGameInternal_(difficulty, colour));
}

// --- TRIGGERS ---
function setupTriggers() {
  preflight();

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('checkForReplies')
    .timeBased()
    .everyMinutes(CONFIG.POLL_MINUTES)
    .create();

  Logger.log('Trigger set: email polling every ' + CONFIG.POLL_MINUTES + ' minutes.');
}

// --- MANUAL START ---
function startFirstGame() {
  preflight();
  startNewGameViaEmail(CONFIG.DIFFICULTY, CONFIG.PLAYER_COLOUR);
}

// --- ONE-STEP SETUP ---
// Run this ONCE to set up everything and start your first game
function quickStart() {
  Logger.log('🔒 Starting Secure Quick Setup...');
  auditLog('SETUP_START', {}, 'INFO');

  try {
    Logger.log('1/4 Initializing GameState sheet...');
    initialiseSheet();

    Logger.log('2/4 Validating API key and email...');
    preflight();

    Logger.log('3/4 Setting up triggers...');
    setupTriggers();

    Logger.log('4/4 Starting first game...');
    startNewGameViaEmail(CONFIG.DIFFICULTY, CONFIG.PLAYER_COLOUR);

    auditLog('SETUP_COMPLETE', {}, 'INFO');
    Logger.log('✅ Secure setup complete! Check your inbox for the first chess email.');
    Logger.log('🔒 Security features enabled: audit logging (bounded), rate limiting, input validation');
    Logger.log('📧 The thread will be labeled "chess-claude" and archived automatically.');
    Logger.log('♟️  Reply with your move to play! (Move must be the first word.)');
  } catch (e) {
    auditLog('SETUP_ERROR', { error: String(e) }, 'CRITICAL');
    throw e;
  }
}

// View persisted audit logs (bounded by retention)
function viewAuditLogs() {
  const props = PropertiesService.getScriptProperties();
  const keys = props.getKeys();
  const logs = [];

  for (const key of keys) {
    if (key.startsWith('AUDIT_')) {
      try {
        const log = JSON.parse(props.getProperty(key));
        logs.push(log);
      } catch (_) {
        // skip
      }
    }
  }

  logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  Logger.log('=== SECURITY AUDIT LOGS ===');
  logs.slice(0, 50).forEach(log => {
    Logger.log(`[${log.timestamp}] ${log.severity}: ${log.event} - ${JSON.stringify(log.details)}`);
  });

  return logs;
}
