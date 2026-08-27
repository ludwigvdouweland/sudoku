# Launches the Sudoku app: starts a local static server (if not already
# running) and opens it in the default browser. Needed because browsers
# block ES modules from loading over a bare file:// URL — see README.md.

$port = 8000
$url = "http://localhost:$port"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

if (-not $listening) {
    Start-Process -FilePath "python" -ArgumentList "-m", "http.server", "$port" `
        -WorkingDirectory $root -WindowStyle Hidden
    Start-Sleep -Seconds 1
}

Start-Process $url
