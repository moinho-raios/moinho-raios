@echo off
title Moinho Raios - Liberar firewall
:: Pede permissao de administrador (o Windows mostra uma janela "Sim / Nao")
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo  Liberando a porta 3000 no Firewall do Windows...
netsh advfirewall firewall delete rule name="Moinho Raios - Controle de Farinha" >nul 2>&1
netsh advfirewall firewall add rule name="Moinho Raios - Controle de Farinha" dir=in action=allow protocol=TCP localport=3000 profile=any
if errorlevel 1 (
  echo.
  echo  Nao foi possivel liberar. Tente clicar com o botao direito
  echo  neste arquivo e escolher "Executar como administrador".
) else (
  echo.
  echo  Pronto! Agora o celular consegue abrir o sistema pelo Wi-Fi.
  echo  Use o endereco "Celular, mesmo Wi-Fi" que aparece na janela preta.
)
echo.
pause
