// ============================================================
// TELEGRAM CHESS BOT — Google Cloud Function
// ============================================================
// Play chess against Stockfish via Telegram. Claude provides
// optional teaching commentary after each move.
//
// Architecture:
//   Telegram webhook → this function → Stockfish Cloud Function
//                                    → Claude API (commentary)
//   Game state stored as JSON in Google Cloud Storage.
//
// Commands:
//   /start or /new  — start a new game
//   /resign         — resign the current game
//   /status         — show current board and game state
//   /difficulty <level> — set difficulty (beginner/intermediate/advanced)
//   /notation       — move notation guide
//   /help           — show help
//   Any message     — interpreted as a chess move (e.g. e4, Nf3, O-O)
// ============================================================

const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');
const { Chess } = require('chess.js');

// --- CONFIGURATION ---
// Set these as environment variables in your Cloud Function deployment.
const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,    // Secret token for webhook verification
  STOCKFISH_URL: process.env.STOCKFISH_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  GCS_BUCKET: process.env.GCS_BUCKET,            // Cloud Storage bucket name
  ALLOWED_CHAT_ID: process.env.ALLOWED_CHAT_ID,  // Optional: restrict to one chat
  DEFAULT_DIFFICULTY: 'intermediate',
  MODEL: 'claude-haiku-4-5-20251001',
};

const TELEGRAM_API = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}`;
const storage = new Storage();

// --- SECURITY HELPERS ---

/** Escape text for safe inclusion in Telegram HTML messages. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Simple in-memory rate limiter (per Cloud Function instance). */
const rateLimit = new Map();
const RATE_LIMIT_WINDOW_MS = 10000; // 10 seconds
const RATE_LIMIT_MAX = 5;           // max requests per window

function isRateLimited(chatId) {
  const now = Date.now();
  const key = String(chatId);
  const entry = rateLimit.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimit.set(key, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

// --- GAME STATE (Cloud Storage JSON) ---

function getStateFilePath(chatId) {
  const safeChatId = String(Number(chatId));
  if (safeChatId === 'NaN') throw new Error('Invalid chat ID');
  return `chess-games/${safeChatId}.json`;
}

function defaultState() {
  return {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveHistory: '',
    gameActive: false,
    moveNumber: 1,
    difficulty: CONFIG.DEFAULT_DIFFICULTY,
    playerColour: 'white',
  };
}

async function loadState(chatId) {
  try {
    const file = storage.bucket(CONFIG.GCS_BUCKET).file(getStateFilePath(chatId));
    const [exists] = await file.exists();
    if (!exists) return defaultState();
    const [content] = await file.download();
    return JSON.parse(content.toString());
  } catch (e) {
    console.error('Failed to load state:', e.message);
    return defaultState();
  }
}

async function saveState(chatId, state) {
  const file = storage.bucket(CONFIG.GCS_BUCKET).file(getStateFilePath(chatId));
  await file.save(JSON.stringify(state, null, 2), {
    contentType: 'application/json',
  });
}

// --- TELEGRAM HELPERS ---

async function sendMessage(chatId, text, parseMode) {
  const MAX_LENGTH = 4096;
  let messageText = text;
  if (text.length > MAX_LENGTH) {
    messageText = text.substring(0, MAX_LENGTH - 30) + '\n\n...(truncated)';
  }
  const body = { chat_id: chatId, text: messageText };
  if (parseMode) body.parse_mode = parseMode;
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error('Telegram sendMessage failed:', resp.status, await resp.text());
  }
}

async function sendTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});
}

// --- BOARD RENDERING ---

function renderBoard(fen) {
  const ranks = fen.split(' ')[0].split('/');
  const whitePieces = { K: 'K', Q: 'Q', R: 'R', B: 'B', N: 'N', P: 'P' };
  const blackPieces = { k: 'k', q: 'q', r: 'r', b: 'b', n: 'n', p: 'p' };
  let board = '';
  for (let i = 0; i < 8; i++) {
    const rankNum = 8 - i;
    let row = rankNum + '  ';
    const rank = ranks[i];
    for (let j = 0; j < rank.length; j++) {
      const ch = rank[j];
      if (ch >= '1' && ch <= '8') {
        for (let k = 0; k < parseInt(ch, 10); k++) row += '.  ';
      } else {
        row += (whitePieces[ch] || blackPieces[ch] || ch) + '  ';
      }
    }
    board += row.trimEnd() + '\n';
  }
  board += '\n   a  b  c  d  e  f  g  h';
  return '<pre>' + board + '</pre>';
}

// --- STOCKFISH CLIENT ---

async function getIdToken(audience) {
  // When running on GCP, use the metadata server to get an ID token
  // for the Stockfish Cloud Function.
  const metadataUrl = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
  const resp = await fetch(metadataUrl, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!resp.ok) {
    throw new Error(`Failed to get ID token: ${resp.status} ${await resp.text()}`);
  }
  return resp.text();
}

async function callStockfish(fen, difficulty) {
  const url = CONFIG.STOCKFISH_URL;
  if (!url) throw new Error('STOCKFISH_URL not configured');

  const idToken = await getIdToken(url);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({ fen, difficulty: difficulty || 'intermediate' }),
  });

  if (!resp.ok) {
    throw new Error(`Stockfish error (${resp.status}): ${await resp.text()}`);
  }

  const json = await resp.json();
  if (!json.move) throw new Error('Stockfish returned no move');

  // Validate evaluation shape
  if (json.evaluation) {
    const ev = json.evaluation;
    if (typeof ev !== 'object' || !['cp', 'mate'].includes(ev.type) || typeof ev.value !== 'number') {
      json.evaluation = null;
    }
  }
  return json;
}

// --- CLAUDE COMMENTARY ---

async function getCommentary(playerMove, engineMove, state) {
  if (!CONFIG.ANTHROPIC_API_KEY) return '';
  try {
    const difficultyInstructions = {
      beginner: 'The player is a beginner. Explain in plain language. Keep it encouraging.',
      intermediate: 'The player is intermediate. Give a brief positional or tactical comment.',
      advanced: 'The player is advanced. Give concise analytical commentary.',
    };
    const systemPrompt = `You are a chess tutor. Comment briefly (1-2 sentences) on the engine's move to help the player learn. Do NOT suggest moves for the player. Respond with plain text only, no JSON or markdown.
Style: ${difficultyInstructions[state.difficulty] || difficultyInstructions.intermediate}`;
    const userMessage = `Position: ${state.fen}\nHistory: ${state.moveHistory || '(start)'}\nPlayer played: ${playerMove}\nEngine replied: ${engineMove}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.MODEL,
        max_tokens: 256,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!resp.ok) return '';
    const json = await resp.json();
    return (json.content && json.content[0] && json.content[0].text) || '';
  } catch (e) {
    console.error('Commentary failed (non-fatal):', e.message);
    return '';
  }
}

// --- MOVE FORMATTING ---

function formatEvaluation(evaluation) {
  if (!evaluation) return '';
  if (evaluation.type === 'cp') {
    const pawns = (evaluation.value / 100).toFixed(1);
    return `Eval: ${evaluation.value > 0 ? '+' : ''}${pawns}`;
  }
  if (evaluation.type === 'mate') {
    return `Mate in ${evaluation.value}`;
  }
  return '';
}

// --- CORE GAME LOGIC ---

function parseMove(text) {
  if (!text) return null;
  const clean = text.trim();
  if (!clean || clean.length > 20) return null;

  // Commands are handled separately — this is just for moves.
  // Castling: accept 0-0 and o-o as O-O
  const castleNorm = clean.toUpperCase().replace(/0/g, 'O');
  if (/^O-O(-O)?$/.test(castleNorm)) return castleNorm;

  // Standard algebraic: Nf3, e4, Bxe5, exd5, Qd1+, e8=Q, etc.
  if (/^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?$/.test(clean)) return clean;

  // Lowercase piece letters (user typed nf3 instead of Nf3)
  const upperFirst = clean.charAt(0).toUpperCase() + clean.slice(1);
  if (/^[KQRBN][a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?$/.test(upperFirst)) return upperFirst;

  return null;
}

async function processMove(chatId, moveStr, state) {
  if (!state.gameActive) {
    await sendMessage(chatId, 'No active game. Send /new to start one.');
    return;
  }

  const chess = new Chess(state.fen);
  const fenTurn = state.fen.split(' ')[1];
  const expectedTurn = state.playerColour === 'white' ? 'w' : 'b';
  if (fenTurn !== expectedTurn) {
    await sendMessage(chatId, "It's not your turn.");
    return;
  }

  // Try to apply the move (chess.js returns null for illegal moves)
  const move = chess.move(moveStr);
  if (!move) {
    const legal = chess.moves();
    await sendMessage(chatId,
      `Illegal move: ${moveStr}\n\nLegal moves: ${legal.slice(0, 15).join(', ')}${legal.length > 15 ? '...' : ''}`);
    return;
  }

  // Player move accepted — snapshot state first for rollback, then update
  const playerSan = move.san;
  const prevFen = state.fen;
  const prevHistory = state.moveHistory;
  const prevMoveNumber = state.moveNumber;

  const movePrefix = state.playerColour === 'white'
    ? state.moveNumber + '.'
    : state.moveNumber + '...';
  state.fen = chess.fen();
  state.moveHistory = (state.moveHistory ? state.moveHistory + ' ' : '') + movePrefix + playerSan;
  if (state.playerColour === 'black') state.moveNumber++;

  // Check if player's move ended the game
  if (chess.in_checkmate() || chess.in_draw()) {
    state.gameActive = false;
    await saveState(chatId, state);
    const result = chess.in_checkmate() ? 'Checkmate!' : 'Draw!';
    await sendMessage(chatId,
      `Your move: ${escapeHtml(playerSan)}\n\n${result}\n\n${renderBoard(state.fen)}\n\nHistory: ${escapeHtml(state.moveHistory)}\n\nSend /new to play again.`, 'HTML');
    return;
  }

  await saveState(chatId, state);
  await sendTyping(chatId);

  // Get engine response — roll back player move on failure
  let engineResult;
  try {
    engineResult = await callStockfish(state.fen, state.difficulty);
  } catch (e) {
    console.error('Stockfish error:', e.message);
    // Roll back so player can resend their move
    state.fen = prevFen;
    state.moveHistory = prevHistory;
    state.moveNumber = prevMoveNumber;
    await saveState(chatId, state);
    await sendMessage(chatId, 'Engine failed to respond. Please send your move again.');
    return;
  }

  // Apply engine move
  const engineChess = new Chess(state.fen);
  const uci = engineResult.move;
  const engineMove = engineChess.move({
    from: uci.substring(0, 2),
    to: uci.substring(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  });
  if (!engineMove) {
    await sendMessage(chatId, `Engine returned invalid move: ${uci}. Game state may be corrupted. Send /new to start over.`);
    return;
  }

  const engineSan = engineMove.san;
  const engineColour = state.playerColour === 'white' ? 'black' : 'white';
  const enginePrefix = engineColour === 'white'
    ? state.moveNumber + '.'
    : state.moveNumber + '...';
  state.fen = engineChess.fen();
  state.moveHistory += ' ' + enginePrefix + engineSan;
  if (engineColour === 'black') state.moveNumber++;

  // Check for game over after engine move
  let gameOverText = '';
  if (engineChess.in_checkmate()) {
    state.gameActive = false;
    gameOverText = `\nCheckmate \u2014 ${engineColour} wins.\n\nSend /new to play again.`;
  } else if (engineChess.in_draw()) {
    state.gameActive = false;
    const reason = engineChess.in_stalemate() ? 'stalemate' :
      engineChess.in_threefold_repetition() ? 'threefold repetition' : 'draw';
    gameOverText = `\nDraw by ${reason}.\n\nSend /new to play again.`;
  }

  await saveState(chatId, state);

  // Get commentary (non-blocking — game state already saved)
  const commentary = await getCommentary(playerSan, engineSan, state);

  // Build response (escape dynamic text for HTML safety)
  const evalText = formatEvaluation(engineResult.evaluation);
  let msg = `Your move: ${escapeHtml(playerSan)}\nEngine: ${escapeHtml(engineSan)}`;
  if (evalText) msg += `  (${escapeHtml(evalText)})`;
  msg += '\n\n' + renderBoard(state.fen);
  if (commentary) msg += `\n\n${escapeHtml(commentary)}`;
  msg += `\n\n${escapeHtml(state.moveHistory)}`;
  if (gameOverText) msg += escapeHtml(gameOverText);

  await sendMessage(chatId, msg, 'HTML');
}

// --- COMMAND HANDLERS ---

async function handleStart(chatId, state, args) {
  const difficulty = (args && args[0] && ['beginner', 'intermediate', 'advanced'].includes(args[0].toLowerCase()))
    ? args[0].toLowerCase()
    : state.difficulty || CONFIG.DEFAULT_DIFFICULTY;

  const newState = defaultState();
  newState.gameActive = true;
  newState.difficulty = difficulty;
  newState.playerColour = 'white';

  await saveState(chatId, newState);

  const board = renderBoard(newState.fen);
  await sendMessage(chatId,
    `New game! You are white. Difficulty: ${escapeHtml(difficulty)}.\n\n${board}\n\nSend your opening move (e.g. e4, d4, Nf3).`, 'HTML');
}

async function handleResign(chatId, state) {
  if (!state.gameActive) {
    await sendMessage(chatId, 'No active game. Send /new to start one.');
    return;
  }
  state.gameActive = false;
  await saveState(chatId, state);
  await sendMessage(chatId,
    `You resigned. Good game!\n\nHistory: ${state.moveHistory}\n\nSend /new to play again.`);
}

async function handleStatus(chatId, state) {
  if (!state.gameActive) {
    await sendMessage(chatId, 'No active game. Send /new to start one.');
    return;
  }
  const board = renderBoard(state.fen);
  const turn = state.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  await sendMessage(chatId,
    `${board}\n\nTurn: ${turn}\nDifficulty: ${escapeHtml(state.difficulty)}\nMove ${state.moveNumber}\n\n${escapeHtml(state.moveHistory) || '(no moves yet)'}`, 'HTML');
}

async function handleDifficulty(chatId, state, args) {
  const level = args && args[0] && args[0].toLowerCase();
  if (!level || !['beginner', 'intermediate', 'advanced'].includes(level)) {
    await sendMessage(chatId,
      `Current difficulty: ${state.difficulty}\n\nUsage: /difficulty beginner|intermediate|advanced`);
    return;
  }
  state.difficulty = level;
  await saveState(chatId, state);
  await sendMessage(chatId, `Difficulty set to ${level}. Takes effect for future engine moves.`);
}

async function handleHelp(chatId) {
  await sendMessage(chatId, [
    'Chess Bot \u2014 play against Stockfish\n',
    'Commands:',
    '  /new \u2014 start a new game',
    '  /resign \u2014 resign current game',
    '  /status \u2014 show board',
    '  /difficulty <level> \u2014 set difficulty',
    '  /notation \u2014 move notation guide',
    '  /help \u2014 this message\n',
    'To move, just send algebraic notation:',
    '  e4, Nf3, Bxe5, O-O, e8=Q',
  ].join('\n'));
}

async function handleNotation(chatId) {
  await sendMessage(chatId, [
    'Move Notation Guide\n',
    'This bot uses Standard Algebraic Notation (SAN).\n',
    'Pieces:',
    '  K = King, Q = Queen, R = Rook',
    '  B = Bishop, N = Knight',
    '  Pawns have no letter prefix.\n',
    'Basic moves:',
    '  e4      \u2014 pawn to e4',
    '  Nf3     \u2014 knight to f3',
    '  Bb5     \u2014 bishop to b5\n',
    'Captures (use x):',
    '  Bxe5    \u2014 bishop captures on e5',
    '  Nxd4    \u2014 knight captures on d4',
    '  exd5    \u2014 pawn on e-file captures on d5',
    '  Note: for pawn captures, use the file',
    '  the pawn is on, not "P". Pxe5 is wrong,',
    '  dxe5 or exd5 is correct.\n',
    'Castling:',
    '  O-O     \u2014 kingside castling',
    '  O-O-O   \u2014 queenside castling',
    '  (0-0 and o-o also accepted)\n',
    'Pawn promotion:',
    '  e8=Q    \u2014 pawn promotes to queen',
    '  exf1=N  \u2014 pawn captures and promotes to knight\n',
    'Check / checkmate:',
    '  Qd7+    \u2014 queen to d7 with check',
    '  Qf7#    \u2014 queen to f7, checkmate',
    '  (+ and # are optional, the bot accepts',
    '  moves with or without them)',
  ].join('\n'));
}

// --- WEBHOOK ENTRY POINT ---

functions.http('telegramWebhook', async (req, res) => {
  // Telegram sends POST with JSON body
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  // Verify webhook secret token (prevents forged requests)
  if (CONFIG.WEBHOOK_SECRET) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (headerSecret !== CONFIG.WEBHOOK_SECRET) {
      console.log('Rejected request: invalid or missing webhook secret token');
      res.status(403).send('Forbidden');
      return;
    }
  }

  const update = req.body;
  const message = update && update.message;
  if (!message || !message.text || !message.chat) {
    res.status(200).send('OK');
    return;
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  // Optional: restrict to a single chat
  if (CONFIG.ALLOWED_CHAT_ID && String(chatId) !== String(CONFIG.ALLOWED_CHAT_ID)) {
    console.log(`Rejected message from unauthorized chat: ${chatId}`);
    res.status(200).send('OK');
    return;
  }

  // Rate limiting
  if (isRateLimited(chatId)) {
    console.log(`Rate limited chat: ${chatId}`);
    res.status(200).send('OK');
    return;
  }

  try {
    const state = await loadState(chatId);

    // Parse commands
    if (text.startsWith('/')) {
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase().replace(/@\w+$/, ''); // strip @botname
      const args = parts.slice(1);

      switch (cmd) {
        case '/start':
        case '/new':
          await handleStart(chatId, state, args);
          break;
        case '/resign':
          await handleResign(chatId, state);
          break;
        case '/status':
        case '/board':
          await handleStatus(chatId, state);
          break;
        case '/difficulty':
          await handleDifficulty(chatId, state, args);
          break;
        case '/help':
          await handleHelp(chatId);
          break;
        case '/notation':
          await handleNotation(chatId);
          break;
        default:
          await sendMessage(chatId, `Unknown command: ${cmd}\nSend /help for available commands.`);
      }
    } else {
      // Not a command — treat as a chess move
      const move = parseMove(text);
      if (move) {
        await processMove(chatId, move, state);
      } else {
        await sendMessage(chatId,
          `Didn't understand "${text}".\n\nSend a move (e.g. e4, Nf3, O-O) or /help.`);
      }
    }
  } catch (e) {
    console.error('Unhandled error:', e);
    try {
      await sendMessage(chatId, 'Something went wrong. Try again or send /new to start over.');
    } catch (_) {}
  }

  res.status(200).send('OK');
});
