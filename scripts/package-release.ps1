$ErrorActionPreference = 'Stop'
$frameRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$frameVersion = (Get-Content -LiteralPath (Join-Path $frameRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($frameVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version' }
$releaseRoot = Join-Path $frameRoot 'release'
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
$stageRoot = Join-Path $releaseRoot ('stage-' + [guid]::NewGuid().ToString('N'))
$bundleRoot = Join-Path $stageRoot ('frame-agent-' + $frameVersion)
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
try {
    # Explicit allowlist: no credentials, database, logs, tooling, or node_modules.
    foreach ($entry in @('server', 'src', 'public', 'agent-skills', 'scripts', 'tests', 'docs', 'dist', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'options.html', 'README.md', '.env.example', '启动 Frame.cmd')) {
        Copy-Item -LiteralPath (Join-Path $frameRoot $entry) -Destination $bundleRoot -Recurse
    }
    Compress-Archive -Path (Join-Path $frameRoot 'dist/*') -DestinationPath (Join-Path $releaseRoot "frame-extension-$frameVersion.zip") -Force
    Compress-Archive -LiteralPath $bundleRoot -DestinationPath (Join-Path $releaseRoot "frame-starter-$frameVersion.zip") -Force
    Write-Output "Packaged extension and starter $frameVersion."
} finally {
    $verifiedStage = [IO.Path]::GetFullPath($stageRoot)
    if ($verifiedStage.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar) -and (Split-Path $verifiedStage -Leaf) -match '^stage-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $verifiedStage -Recurse -Force
    } else { throw 'Unexpected staging directory; cleanup skipped' }
}
