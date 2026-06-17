#!/usr/bin/env python3
"""Setup GMGN .env from PEM private key."""
import os

priv_path = os.path.expanduser("~/.config/gmgn/gmgn_private.pem")
env_path = os.path.expanduser("~/.config/gmgn/.env")

with open(priv_path) as f:
    priv = f.read().strip()

with open(env_path, "w") as f:
    f.write("GMGN_API_KEY=gmgn_5...f.write(priv)
    f.write('"\n')

os.chmod(env_path, 0o600)

# Verify
with open(env_path) as f:
    content = f.read()
assert "gmgn_5...0 and "BEGIN PRIVATE" in content
print("GMGN .env configured OK")
print(f"API key: gmgn_5...print(f"Private key: {len(priv)} chars")
