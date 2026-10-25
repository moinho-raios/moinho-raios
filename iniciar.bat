@echo off
chcp 65001 >nul
title Moinho Raios - Controle de Farinha
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  O Node.js nao esta instalado neste computador.
  echo  Baixe e instale a versao LTS em: https://nodejs.org
  echo  Depois de instalar, de dois cliques neste arquivo de novo.
  echo.
  pause
  exit /b
)
start "" http://localhost:3000
node server.js
pause
