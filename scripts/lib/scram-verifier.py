#!/usr/bin/env python3
"""scram-verifier.py: print the PostgreSQL SCRAM-SHA-256 verifier for a password.

Usage:  printf '%s' "$PASSWORD" | python3 scram-verifier.py [--iterations N] [--salt-b64 B64]

The password is read from STDIN, never from an argument: arguments are
visible to every process on the host (/proc/<pid>/cmdline), stdin is not.
One trailing newline is stripped, so `echo` and `printf '%s'` agree.

The verifier is printed on stdout:

    SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>

PostgreSQL stores a password given in this form as is, whatever
password_encryption says, so

    ALTER ROLE some_login WITH PASSWORD 'SCRAM-SHA-256$...'

sets a login's password without the plaintext ever appearing in a statement,
an argument, a server log or an audit log. The computation is RFC 5802 / RFC
7677 with PostgreSQL's defaults (4096 iterations, a 16-byte random salt).
PostgreSQL applies SASLprep to the password, but passes an all-ASCII password
through unchanged; this helper accepts only visible ASCII, so the bytes it
hashes are exactly the bytes PostgreSQL and libpq hash.

Exit codes: 0 success; 2 usage error; 3 the input was refused. Error messages
never contain the password or the arguments.

Standard library only: it runs on the ops host's stock python3 (3.9 on
Amazon Linux 2023).
"""

import argparse
import base64
import binascii
import hashlib
import hmac
import secrets
import sys

PROG = "scram-verifier"
DEFAULT_ITERATIONS = 4096
MIN_ITERATIONS = 4096
MAX_ITERATIONS = 10_000_000
SALT_BYTES = 16
MIN_SALT_BYTES = 16


class QuietParser(argparse.ArgumentParser):
    """An argument parser whose errors never echo what was passed.

    argparse's default error names the offending value ("unrecognized
    arguments: <value>"), and a password passed by mistake as an argument
    must not be printed back.
    """

    def error(self, message):  # noqa: D401 - argparse hook
        sys.stderr.write(
            "%s: error: invalid arguments (the password is read from stdin; "
            "see --help)\n" % PROG
        )
        sys.exit(2)


def usage_error(message):
    sys.stderr.write("%s: error: %s\n" % (PROG, message))
    sys.exit(2)


def refuse(message):
    sys.stderr.write("%s: refused: %s\n" % (PROG, message))
    sys.exit(3)


def read_password():
    raw = sys.stdin.buffer.read()
    if raw.endswith(b"\r\n"):
        raw = raw[:-2]
    elif raw.endswith(b"\n"):
        raw = raw[:-1]
    if not raw:
        refuse("the password on stdin is empty")
    # Visible ASCII only (0x21-0x7e): no spaces, no control characters, no
    # second line, nothing SASLprep could rewrite.
    if any(b < 0x21 or b > 0x7E for b in raw):
        refuse("the password must be visible ASCII on a single line")
    return raw


def parse_salt(value):
    if value is None:
        return secrets.token_bytes(SALT_BYTES)
    try:
        salt = base64.b64decode(value.encode("ascii"), validate=True)
    except (binascii.Error, ValueError, UnicodeEncodeError):
        usage_error("--salt-b64 is not valid base64")
    if len(salt) < MIN_SALT_BYTES:
        usage_error("--salt-b64 must decode to at least %d bytes" % MIN_SALT_BYTES)
    return salt


def verifier(password, salt, iterations):
    salted = hashlib.pbkdf2_hmac("sha256", password, salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return "SCRAM-SHA-256$%d:%s$%s:%s" % (iterations, b64(salt), b64(stored_key), b64(server_key))


def main():
    parser = QuietParser(
        prog=PROG,
        description="Print the PostgreSQL SCRAM-SHA-256 verifier for the password on stdin.",
    )
    parser.add_argument("--iterations", default=str(DEFAULT_ITERATIONS),
                        help="PBKDF2 iteration count (default %d, PostgreSQL's)" % DEFAULT_ITERATIONS)
    parser.add_argument("--salt-b64", default=None,
                        help="fixed base64 salt, for tests; default: 16 random bytes")
    args = parser.parse_args()

    try:
        iterations = int(args.iterations, 10)
    except ValueError:
        usage_error("--iterations must be a whole number")
    if not MIN_ITERATIONS <= iterations <= MAX_ITERATIONS:
        usage_error("--iterations must be between %d and %d" % (MIN_ITERATIONS, MAX_ITERATIONS))

    salt = parse_salt(args.salt_b64)
    password = read_password()
    sys.stdout.write(verifier(password, salt, iterations) + "\n")


if __name__ == "__main__":
    main()
