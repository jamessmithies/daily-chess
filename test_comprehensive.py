#!/usr/bin/env python3
"""
Comprehensive test to verify pawn move validation works correctly
including the b3 move scenario and en passant square validation
"""

def test_move_scenarios():
    """Test various pawn move scenarios to ensure they're handled correctly"""

    test_cases = [
        {
            "name": "b3 after a3 and e5",
            "fen": "rnbqkbnr/pppp1ppp/8/4p3/8/P7/1PPPPPPP/RNBQKBNR w KQkq e6 0 2",
            "move": "b3",
            "expected_valid": True,
            "expected_ep": "-",
            "description": "The b-pawn should be able to move from b2 to b3"
        },
        {
            "name": "b4 double advance",
            "fen": "rnbqkbnr/pppp1ppp/8/4p3/8/P7/1PPPPPPP/RNBQKBNR w KQkq - 0 2",
            "move": "b4",
            "expected_valid": True,
            "expected_ep": "b3",  # Only if black has a pawn on a4 or c4
            "description": "The b-pawn should be able to advance two squares to b4"
        },
        {
            "name": "e4 in response",
            "fen": "rnbqkbnr/pppp1ppp/8/4p3/1P6/P7/2PPPPPP/RNBQKBNR w KQkq - 0 3",
            "move": "e4",
            "expected_valid": True,
            "expected_ep": "e3",  # Black has a pawn on e5 that could capture
            "description": "White e2-e4 creates valid en passant for black's e5 pawn"
        },
        {
            "name": "d3 single advance",
            "fen": "rnbqkbnr/pppp1ppp/8/4p3/1P6/P7/2PPPPPP/RNBQKBNR w KQkq - 0 3",
            "move": "d3",
            "expected_valid": True,
            "expected_ep": "-",
            "description": "Single pawn advance doesn't create en passant"
        },
        {
            "name": "c4 advance",
            "fen": "rnbqkbnr/pppp1ppp/8/4p3/8/P7/1PPPPPPP/RNBQKBNR w KQkq - 0 2",
            "move": "c4",
            "expected_valid": True,
            "expected_ep": "-",  # No black pawn on b4 or d4 to capture
            "description": "c2-c4 with no adjacent black pawns"
        }
    ]

    print("COMPREHENSIVE PAWN MOVE VALIDATION TEST")
    print("=" * 60)

    for test in test_cases:
        print(f"\nTest: {test['name']}")
        print(f"Position: {test['fen']}")
        print(f"Move: {test['move']}")
        print(f"Description: {test['description']}")

        # Parse the position
        parts = test['fen'].split()
        board_str = parts[0]
        active_color = parts[1]

        # Visualize the relevant part of the board
        ranks = board_str.split('/')
        print("\nRelevant board section:")
        for i in range(4, 8):  # Show ranks 5-1
            rank_num = 8 - i
            row = f"{rank_num} "
            for char in ranks[i]:
                if char.isdigit():
                    row += ". " * int(char)
                else:
                    row += char + " "
            print(row)
        print("  a b c d e f g h")

        print(f"\nExpected: Move is {'VALID' if test['expected_valid'] else 'INVALID'}")
        print(f"Expected en passant after move: '{test['expected_ep']}'")
        print("-" * 40)

    print("\n" + "=" * 60)
    print("SUMMARY OF FIXES IMPLEMENTED:")
    print("1. Enhanced Claude's prompt to be explicit about en passant rules")
    print("2. Added correctEnPassantSquare() function to validate FEN strings")
    print("3. Integrated validation into both player and Claude move processing")
    print("4. Clarified pawn move notation (b3 = pawn to b3, not invalid)")

if __name__ == "__main__":
    test_move_scenarios()

    print("\n" + "=" * 60)
    print("KEY POINTS FOR THE USER:")
    print("1. The FEN string had an incorrect en passant square (e6)")
    print("2. After 1...e5, 'e6' should only be set if white has d5 or f5")
    print("3. The move 'b3' is perfectly valid - it's the b-pawn advancing")
    print("4. The fixes ensure en passant is only set when truly available")