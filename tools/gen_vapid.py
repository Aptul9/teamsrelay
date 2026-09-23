#!/usr/bin/env python3
"""Genera le chiavi VAPID per le notifiche Web Push di TeamsRelay.

Crea nella cartella indicata:
  private_key.pem  -> chiave PRIVATA usata dall'agent per firmare le push (NON committarla)
  appkey.txt       -> applicationServerKey pubblica (base64url) che la web app passa al browser

Uso:  python gen_vapid.py vapid
Senza Python locale:
  docker run --rm -v "$PWD:/w" -w /w python:3.12-slim \
    sh -c "pip install -q cryptography && python tools/gen_vapid.py vapid"
"""
import base64
import os
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

out = sys.argv[1] if len(sys.argv) > 1 else "vapid"
os.makedirs(out, exist_ok=True)
priv_path = os.path.join(out, "private_key.pem")
if os.path.exists(priv_path):
    sys.exit(f"{priv_path} esiste gia': non lo sovrascrivo "
             "(le sottoscrizioni push dei dispositivi smetterebbero di funzionare).")

key = ec.generate_private_key(ec.SECP256R1())
with open(priv_path, "wb") as f:
    f.write(key.private_bytes(serialization.Encoding.PEM,
                              serialization.PrivateFormat.PKCS8,
                              serialization.NoEncryption()))
os.chmod(priv_path, 0o600)

raw = key.public_key().public_bytes(serialization.Encoding.X962,
                                    serialization.PublicFormat.UncompressedPoint)
appkey = base64.urlsafe_b64encode(raw).decode().rstrip("=")
with open(os.path.join(out, "appkey.txt"), "w") as f:
    f.write(appkey)

print("OK: chiavi VAPID generate in", out)
print("applicationServerKey:", appkey)
