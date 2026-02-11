#!/usr/bin/env python3
"""Test script to validate chess move processing logic"""

import json
import anthropic
import os

# Test data from the issue
TEST_FEN = "rnbqkbnr/pppp1ppp/8/4p3/8/P7/1PPPPPPP/RNBQKBNR w KQkq e6 0 2"
MOVE_HISTORY = "1.a3 1...e5"
TEST_MOVE = "b3"
PLAYER_COLOR = "white"

def test_move_validation(api_key):
    """Test the move validation logic as it would run in the Google Apps Script"""

    client = anthropic.Anthropic(api_key=api_key)

    system_prompt = f"""You are a chess validator. The player is {PLAYER_COLOR}.

The player submitted: "{TEST_MOVE}"

Analyze the current position carefully and determine if this is a legal move.

IMPORTANT RULES FOR MOVE INTERPRETATION:
- If the move is just a square like "b3", "e4", "d5" (no piece letter), it's a PAWN move to that square
- The move "b3" means: move the pawn that can legally reach b3 (usually the b-pawn moving forward)
- For piece moves, they include the piece letter: "Nf3", "Be5", "Qd4"
- Castling is written as "O-O" or "O-O-O"

If this is a legal chess move in the current position:
- Return: {{"valid":true,"fen":"<new FEN after the move>","move":"<standardized algebraic notation>"}}
- IMPORTANT: Set en passant square to "-" unless a pawn just moved two squares AND an opponent pawn can capture it

If illegal:
- Return: {{"valid":false,"reason":"<why it's illegal>"}}

Double-check that pawn moves like "b3", "e4", "h6" are treated as pawn moves, not as invalid notation.
Return ONLY the JSON, no other text."""

    user_message = f"""Current FEN: {TEST_FEN}
Move history: {MOVE_HISTORY}
Player's move: {TEST_MOVE}"""

    print("Testing move validation...")
    print(f"Position: {TEST_FEN}")
    print(f"Move History: {MOVE_HISTORY}")
    print(f"Testing move: {TEST_MOVE}")
    print("-" * 50)

    try:
        response = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=1024,
            temperature=0.1,
            system=system_prompt,
            messages=[{"role": "user", "content": user_message}]
        )

        response_text = response.content[0].text
        print("Claude's response:")
        print(response_text)
        print("-" * 50)

        # Parse the response
        try:
            result = json.loads(response_text)
            print("\nParsed result:")
            print(json.dumps(result, indent=2))

            if result.get("valid"):
                print(f"\n✓ Move '{TEST_MOVE}' is VALID")
                print(f"  Standardized notation: {result.get('move')}")
                print(f"  New FEN: {result.get('fen')}")
            else:
                print(f"\n✗ Move '{TEST_MOVE}' is INVALID")
                print(f"  Reason: {result.get('reason')}")

        except json.JSONDecodeError as e:
            print(f"Error parsing JSON response: {e}")

    except Exception as e:
        print(f"Error calling Claude API: {e}")

def analyze_position():
    """Analyze the current board position to understand valid moves"""
    print("\nBoard Analysis")
    print("=" * 50)
    print("Current position (FEN):", TEST_FEN)
    print("\nBoard visualization:")

    # Parse FEN to show board
    board_part = TEST_FEN.split()[0]
    ranks = board_part.split('/')

    for i, rank in enumerate(ranks):
        rank_num = 8 - i
        row = f"{rank_num} "
        for char in rank:
            if char.isdigit():
                row += ". " * int(char)
            else:
                row += char + " "
        print(row)
    print("  a b c d e f g h")

    print("\nPosition details:")
    print(f"- It's {PLAYER_COLOR}'s turn")
    print(f"- The b-pawn is on b2 (can move to b3 or b4)")
    print(f"- Move 'b3' should be a valid pawn advance")
    print(f"- Previous moves: {MOVE_HISTORY}")

if __name__ == "__main__":
    # First, analyze the position
    analyze_position()

    # Check for API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("\n⚠️  ANTHROPIC_API_KEY not set in environment")
        print("To test with the actual Claude API, set the environment variable")
        print("export ANTHROPIC_API_KEY='your-api-key-here'")
    else:
        print("\n" + "=" * 50)
        test_move_validation(api_key)