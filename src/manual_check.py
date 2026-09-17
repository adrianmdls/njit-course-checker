"""Check all configured courses once without changing automated state."""

from datetime import datetime

from checker import check_once
from output import print_results


def main():
    started = datetime.now()
    results, errors = check_once(persist_state=False)
    print_results(started, results, errors)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
