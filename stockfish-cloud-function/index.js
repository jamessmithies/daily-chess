const functions = require('@google-cloud/functions-framework');
const { spawn } = require('child_process');
const path = require('path');

// Difficulty presets: maps difficulty name to Stockfish UCI options
const DIFFICULTY_PRESETS = {
  beginner:     { skillLevel: 3,  depth: 5  },
  intermediate: { skillLevel: 10, depth: 10 },
  advanced:     { skillLevel: 20, depth: 15 },
};

const ENGINE_PATH = path.join(
  __dirname,
  'node_modules',
  'stockfish',
  'src',
  'stockfish-nnue-16.js'
);

/**
 * Spawns Stockfish as a child process, sends UCI commands,
 * and returns the best move for the given FEN and difficulty.
 *
 * The child process approach avoids event-loop blocking with the WASM engine.
 */
function getBestMove(fen, difficulty) {
  return new Promise((resolve, reject) => {
    const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.intermediate;

    const engine = spawn(process.execPath, [ENGINE_PATH], { stdio: 'pipe' });

    const outputLines = [];
    let phase = 'uci';  // uci -> ready -> search -> done
    let settled = false;

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { engine.kill(); } catch (_) {}
      if (err) reject(err);
      else resolve(result);
    }

    // Hard timeout: 60 seconds
    const timer = setTimeout(() => {
      finish(new Error('Engine timeout after 60 seconds'));
    }, 60000);

    engine.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter((l) => l.trim());

      for (const line of lines) {
        if (settled) return;

        if (phase === 'uci' && line === 'uciok') {
          phase = 'ready';
          engine.stdin.write(`setoption name Skill Level value ${preset.skillLevel}\n`);
          engine.stdin.write('setoption name Threads value 1\n');
          engine.stdin.write('ucinewgame\n');
          engine.stdin.write('isready\n');
        } else if (phase === 'ready' && line === 'readyok') {
          phase = 'search';
          engine.stdin.write(`position fen ${fen}\n`);
          engine.stdin.write(`go depth ${preset.depth}\n`);
        } else if (phase === 'search') {
          outputLines.push(line);

          if (line.startsWith('bestmove')) {
            phase = 'done';
            engine.stdin.write('quit\n');

            // Parse bestmove
            const match = line.match(/bestmove\s+(\S+)/);
            if (!match) {
              finish(new Error('Could not parse bestmove: ' + line));
              return;
            }

            // Extract evaluation from search info lines
            let evaluation = null;
            for (let i = outputLines.length - 1; i >= 0; i--) {
              const evalMatch = outputLines[i].match(/score\s+(cp|mate)\s+(-?\d+)/);
              if (evalMatch) {
                evaluation = {
                  type: evalMatch[1],
                  value: parseInt(evalMatch[2], 10),
                };
                break;
              }
            }

            finish(null, { move: match[1], evaluation });
          }
        }
      }
    });

    engine.stderr.on('data', (data) => {
      // Stockfish sometimes sends bench results to stderr; ignore
    });

    engine.on('error', (err) => {
      finish(new Error('Failed to spawn engine: ' + err.message));
    });

    engine.on('close', (code) => {
      if (!settled) {
        finish(new Error('Engine exited unexpectedly with code ' + code));
      }
    });

    // Start UCI handshake
    engine.stdin.write('uci\n');
  });
}

/**
 * HTTP Cloud Function entry point.
 *
 * Expects POST with JSON body:
 *   { "fen": "<FEN string>", "difficulty": "beginner|intermediate|advanced" }
 *
 * Returns JSON:
 *   { "move": "<UCI move e.g. g1f3>", "evaluation": { "type": "cp|mate", "value": <number> } }
 *
 * Authentication: This function should be deployed with --no-allow-unauthenticated.
 * GAS calls it with an OAuth token via ScriptApp.getOAuthToken().
 */
functions.http('getMove', async (req, res) => {
  // Only accept POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const { fen, difficulty } = req.body || {};

  // Validate FEN
  if (!fen || typeof fen !== 'string') {
    res.status(400).json({ error: 'Missing or invalid "fen" field.' });
    return;
  }
  if (fen.length > 200) {
    res.status(400).json({ error: 'FEN string too long.' });
    return;
  }
  // Basic FEN format check: should have 6 space-separated fields
  const fenParts = fen.trim().split(/\s+/);
  if (fenParts.length !== 6) {
    res.status(400).json({ error: 'Invalid FEN format (expected 6 fields).' });
    return;
  }

  // Validate difficulty
  const diff = (difficulty || 'intermediate').toLowerCase();
  if (!DIFFICULTY_PRESETS[diff]) {
    res.status(400).json({
      error: `Invalid difficulty "${difficulty}". Use: beginner, intermediate, or advanced.`,
    });
    return;
  }

  try {
    const result = await getBestMove(fen, diff);
    res.status(200).json(result);
  } catch (err) {
    console.error('Engine error:', err);
    res.status(500).json({ error: 'Engine failed: ' + err.message });
  }
});