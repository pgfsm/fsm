"""Shared fixtures.

`tls`: throwaway TLS material -- a CA, a server certificate for
localhost/127.0.0.1 and a client certificate (mutual TLS), all signed by that
CA and made with openssl at test time, so no private key is committed (the
pre-commit secrets scan would reject one). Needs `openssl` on PATH.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Iterator, List

import pytest


@dataclass(frozen=True)
class TlsFiles:
    dir: str
    ca_file: str
    cert_file: str
    key_file: str
    client_cert_file: str
    client_key_file: str


def _openssl(args: List[str], cwd: str) -> None:
    done = subprocess.run(["openssl", *args], cwd=cwd, capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"openssl {args[0]} failed: {done.stderr}")


@pytest.fixture(scope="session")
def tls() -> Iterator[TlsFiles]:
    with tempfile.TemporaryDirectory(prefix="pgfsm-sdk-tls-") as d:
        _openssl(
            ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
             "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=pgfsm-test-ca"],
            d,
        )  # fmt: skip
        _openssl(
            ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key",
             "-out", "server.csr", "-subj", "/CN=localhost"],
            d,
        )  # fmt: skip
        with open(os.path.join(d, "san.ext"), "w") as f:
            f.write("subjectAltName=DNS:localhost,IP:127.0.0.1\n")
        _openssl(
            ["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
             "-CAcreateserial", "-days", "1", "-out", "server.crt", "-extfile", "san.ext"],
            d,
        )  # fmt: skip
        _openssl(
            ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key",
             "-out", "client.csr", "-subj", "/CN=pgfsm-test-worker"],
            d,
        )  # fmt: skip
        _openssl(
            ["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
             "-CAcreateserial", "-days", "1", "-out", "client.crt"],
            d,
        )  # fmt: skip
        yield TlsFiles(
            dir=d,
            ca_file=os.path.join(d, "ca.crt"),
            cert_file=os.path.join(d, "server.crt"),
            key_file=os.path.join(d, "server.key"),
            client_cert_file=os.path.join(d, "client.crt"),
            client_key_file=os.path.join(d, "client.key"),
        )
