@echo off
title Moinho Raios - Acesso pela internet
cd /d "%~dp0"
echo.
echo  ACESSO PELA INTERNET - tunel seguro Cloudflare
echo  ---------------------------------------------
echo  Deixe ABERTAS esta janela e a janela do sistema, iniciar.bat.
echo.
set "CF=cloudflared"
where cloudflared >nul 2>nul
if not errorlevel 1 goto rodar
if exist "%~dp0cloudflared.exe" (
  set "CF=%~dp0cloudflared.exe"
  goto rodar
)

echo  Instalando o cloudflared, so na primeira vez...
winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto manual
echo.
echo  Instalado! Feche esta janela e de dois cliques no tunel.bat de novo.
echo.
pause
exit /b

:manual
echo.
echo  Nao foi possivel instalar automaticamente.
echo  1. Baixe o arquivo cloudflared-windows-amd64.exe em:
echo     https://github.com/cloudflare/cloudflared/releases/latest
echo  2. Renomeie para cloudflared.exe e coloque nesta pasta.
echo  3. De dois cliques no tunel.bat de novo.
echo.
pause
exit /b

:rodar
echo  Em alguns segundos aparece uma linha com um endereco assim:
echo     https://palavras-aleatorias.trycloudflare.com
echo  Abra esse endereco em qualquer celular ou computador, de qualquer lugar.
echo  O endereco muda cada vez que o tunel e aberto.
echo.
"%CF%" tunnel --url http://localhost:3000
pause
