#!/usr/bin/env python3
"""
Script to validate and correct en passant squares in FEN strings
"""

def validate_en_passant(fen, last_move=None):
    """
    Validate and correct the en passant square in a FEN string

    Args:
        fen: The FEN string to validate
        last_move: The last move played (optional, for context)

    Returns:
        Corrected FEN string with proper en passant square
    """
    parts = fen.split()
    if len(parts) != 6:
        return fen  # Invalid FEN format

    board_part = parts[0]
    active_color = parts[1]
    castling = parts[2]
    en_passant = parts[3]
    halfmove = parts[4]
    fullmove = parts[5]

    # Parse the board
    ranks = board_part.split('/')
    board = []
    for rank in ranks:
        row = []
        for char in rank:
            if char.isdigit():
                row.extend(['.'] * int(char))
            else:
                row.append(char)
        board.append(row)

    # Check if the current en passant square is valid
    if en_passant != '-':
        file_idx = ord(en_passant[0]) - ord('a')
        rank = int(en_passant[1])

        # Determine which color just moved (opposite of active color)
        last_moved = 'black' if active_color == 'w' else 'white'

        # Check conditions for valid en passant
        valid = False

        if last_moved == 'white' and rank == 3:
            # White just moved, en passant square is on rank 3
            # Check if white has a pawn on rank 4 in this file
            if 0 <= file_idx < 8 and board[4][file_idx] == 'P':
                # Check if black has pawns that could capture
                if file_idx > 0 and board[4][file_idx-1] == 'p':
                    valid = True
                if file_idx < 7 and board[4][file_idx+1] == 'p':
                    valid = True

        elif last_moved == 'black' and rank == 6:
            # Black just moved, en passant square is on rank 6
            # Check if black has a pawn on rank 5 in this file
            if 0 <= file_idx < 8 and board[3][file_idx] == 'p':
                # Check if white has pawns that could capture
                if file_idx > 0 and board[3][file_idx-1] == 'P':
                    valid = True
                if file_idx < 7 and board[3][file_idx+1] == 'P':
                    valid = True

        if not valid:
            print(f"Invalid en passant square '{en_passant}' - correcting to '-'")
            en_passant = '-'

    # Reconstruct the FEN
    corrected_fen = f"{board_part} {active_color} {castling} {en_passant} {halfmove} {fullmove}"
    return corrected_fen

def test_validation():
    """Test the validation with known cases"""

    test_cases = [
        {
            "fen": "rnbqkbnr/pppp1ppp/8/4p3/8/P7/1PPPPPPP/RNBQKBNR w KQkq e6 0 2",
            "description": "After 1.a3 e5 - e6 is invalid (no white pawn can capture)",
            "expected_ep": "-"
        },
        {
            "fen": "rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR b KQkq e6 0 2",
            "description": "After white d5, black e5 - e6 is valid (white d5 can capture)",
            "expected_ep": "e6"
        },
        {
            "fen": "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq d6 0 2",
            "description": "After white d4, black d5 - d6 is invalid (pieces already past each other)",
            "expected_ep": "-"
        }
    ]

    for i, test in enumerate(test_cases, 1):
        print(f"\nTest {i}: {test['description']}")
        print(f"Original FEN: {test['fen']}")
        corrected = validate_en_passant(test['fen'])
        print(f"Corrected FEN: {corrected}")

        parts = corrected.split()
        actual_ep = parts[3] if len(parts) > 3 else "?"

        if actual_ep == test['expected_ep']:
            print(f"✓ PASS - En passant square correctly set to '{actual_ep}'")
        else:
            print(f"✗ FAIL - Expected '{test['expected_ep']}', got '{actual_ep}'")

if __name__ == "__main__":
    print("EN PASSANT SQUARE VALIDATION TOOL")
    print("=" * 50)

    # Test with the problematic FEN from the issue
    problem_fen = "rnbqkbnr/pppp1ppp/8/4p3/8/P7/1PPPPPPP/RNBQKBNR w KQkq e6 0 2"
    print(f"\nProblem FEN from issue:")
    print(f"Input:  {problem_fen}")
    corrected = validate_en_passant(problem_fen)
    print(f"Output: {corrected}")

    print("\n" + "=" * 50)
    print("Running validation tests...")
    test_validation()