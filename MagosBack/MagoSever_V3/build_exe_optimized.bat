@echo off
REM 与打包协议一致：产物在 <仓库根>\dist\MagosServer.exe，由 build_exe.py 内 distpath/workpath 控制
cd /d "%~dp0"
python build_exe.py
