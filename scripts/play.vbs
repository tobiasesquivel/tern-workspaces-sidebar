' Hidden player launcher.
'
' Run with wscript.exe (a GUI-subsystem host: no console window of its own).
' It starts PowerShell hidden from creation (window style 0), so a chime never
' flashes a console box: PowerShell is a console-subsystem program and spawning
' it straight from the plugin pops one on every sound, which -WindowStyle Hidden
' alone would only hide after it appeared. Waits for playback, then exits with
' PowerShell's own exit code. No error dialog, ever.
'
' Usage: wscript.exe //Nologo play.vbs <audio-file> <play.ps1>
'
' This launcher is tern-chime's (same author, same trick) with the player script
' passed in as the second argument instead of being spelled out here.
Option Explicit
On Error Resume Next

If WScript.Arguments.Count < 2 Then
	WScript.Quit 1
End If

Dim sh, file, ps1, cmd, code
Set sh = CreateObject("WScript.Shell")
If Err.Number <> 0 Then
	WScript.Quit 1
End If

file = WScript.Arguments(0)
ps1 = WScript.Arguments(1)
cmd = "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass" _
	& " -WindowStyle Hidden -File """ & ps1 & """ -Path """ & file & """"

code = sh.Run(cmd, 0, True)
If Err.Number <> 0 Then
	WScript.Quit 1
End If
WScript.Quit code
