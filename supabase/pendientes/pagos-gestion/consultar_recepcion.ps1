# Consulta SEGURA de un correo recibido en Resend (PowerShell). Muestra solo `authentication`, nombres de cabeceras y si hay cuerpo.
# No imprime el cuerpo ni la clave. La API key se pide sin eco, no se guarda y solo se envia a https://api.resend.com.
# Uso:  .\consultar_recepcion.ps1 -EmailId <email_id>
param([Parameter(Mandatory = $true)][string]$EmailId)
if ($EmailId -notmatch '^[A-Za-z0-9_-]{6,80}$') { Write-Error 'email_id invalido'; exit 2 }
$sec = Read-Host 'Resend API key (no se muestra)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  try { $r = Invoke-RestMethod -Method Get -Uri "https://api.resend.com/emails/receiving/$EmailId" -Headers @{ Authorization = "Bearer $key" } }
  catch {
    $c = 0; if ($_.Exception.Response) { $c = [int]$_.Exception.Response.StatusCode }
    Write-Output "HTTP $c"
    if ($c -in 401, 403) { Write-Output 'La API key no tiene permiso de lectura de correos recibidos (o es invalida).' } elseif ($c -eq 404) { Write-Output 'email_id no encontrado.' }
    exit 1
  }
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $key = $null }
Write-Output 'HTTP 200'
Write-Output ('authentication = ' + ($r.authentication | ConvertTo-Json -Compress))
$dm = $null; if ($r.authentication) { $dm = $r.authentication.dmarc }
$v = if ($dm -is [string] -and $dm.ToLower() -eq 'pass') { 'VERIFICADO' } elseif ($dm -eq 'processing_failed') { 'REINTENTAR' } else { 'NO VERIFICADO' }
Write-Output "dmarc = $dm => regla actual: $v"
$n = @(); if ($r.headers) { $n = $r.headers.PSObject.Properties.Name | ForEach-Object { $_.ToLower() } | Where-Object { $_ -match '^[a-z0-9\-]{1,40}$' } | Sort-Object }
Write-Output ('cabeceras = ' + ($n -join ','))
Write-Output ('tiene_texto = ' + [bool]$r.text + ' | tiene_html = ' + [bool]$r.html + ' | adjuntos = ' + @($r.attachments).Count)
