#!/bin/sh
# Inicia o Controle de Farinha no Linux ou Mac
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "O Node.js não está instalado. Instale a versão LTS em https://nodejs.org"
  exit 1
fi
node server.js
