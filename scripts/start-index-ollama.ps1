$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localExecutable = Join-Path $projectRoot 'data/tools/ollama/ollama.exe'
if (Test-Path -LiteralPath $localExecutable) {
    $ollamaExecutable = $localExecutable
} else {
    $ollamaExecutable = (Get-Command ollama -ErrorAction Stop).Source
}
try {
    Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' | Out-Null
    Write-Output 'Ollama already listens on port 11434.'
    exit 0
} catch { }
$modelDirectory = Join-Path $projectRoot 'data/ollama-models'
$logDirectory = Join-Path $projectRoot 'data/tools'
New-Item -ItemType Directory -Force -Path $modelDirectory, $logDirectory | Out-Null
$previousModels = $env:OLLAMA_MODELS
$previousHost = $env:OLLAMA_HOST
try {
    $env:OLLAMA_MODELS = $modelDirectory
    $env:OLLAMA_HOST = '127.0.0.1:11434'
    $process = Start-Process -FilePath $ollamaExecutable -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDirectory 'ollama.stdout.log') `
        -RedirectStandardError (Join-Path $logDirectory 'ollama.stderr.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if ($process.HasExited) { break }
        try {
            Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' | Out-Null
            $ready = $true
            break
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ready) {
        throw "Ollama did not start. See $logDirectory/ollama.stderr.log"
    }
    Write-Output "Started Ollama PID $($process.Id). Models: $modelDirectory"
} finally {
    $env:OLLAMA_MODELS = $previousModels
    $env:OLLAMA_HOST = $previousHost
}
