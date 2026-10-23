@echo off
chcp 65001 >nul
rem Publishes the site to GitHub Pages. Double-click after every change.
rem The first run asks for the address of your empty GitHub repository.

cd /d "%~dp0"

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo First publish. Paste the address of your GitHub repository,
  echo for example: https://github.com/yourname/anaenby.git
  set /p REPO=Repository address:
  call git remote add origin %%REPO%%
)

git add -A
git commit -m "Update site %date% %time%" >nul 2>&1
git push -u origin main
if errorlevel 1 (
  echo.
  echo Publishing failed. Copy this window and send it to Claude.
) else (
  echo.
  echo Published. GitHub updates the site in about a minute.
)
echo.
pause
