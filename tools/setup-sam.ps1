# Sets up tools/.venv-sam for SAM 2 based sprite segmentation.
#
# RTX 50-series (Blackwell, sm_120) needs a cu128-or-later PyTorch build; the default
# PyPI "torch" wheel does not support this architecture. Run from the tools/ directory:
#
#   powershell -File setup-sam.ps1
#
# Re-running is safe: it reuses the existing venv and re-installs on top of it.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Test-Path ".venv-sam")) {
    python -m venv .venv-sam
}

$venvPython = Join-Path $here ".venv-sam\Scripts\python.exe"

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
& $venvPython -m pip install -r requirements-sam.txt

& $venvPython -c "import torch; print('torch', torch.__version__, 'cuda available:', torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no cuda device')"
