import argparse

from .server import run_daemon


def main() -> int:
    parser = argparse.ArgumentParser(prog="archmap serve")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--db")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    run_daemon(args.workspace, args.db, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
