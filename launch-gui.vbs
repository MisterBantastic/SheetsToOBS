Option Explicit
Dim WshShell, fso, appDir, nodeBin, serverJs
Dim edgePath, edgePath64, chromePath, chromePath86

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 1. Find Node.js Runtime
nodeBin = ""
If fso.FileExists(appDir & "\runtime\node.exe") Then
    nodeBin = appDir & "\runtime\node.exe"
ElseIf fso.FileExists(appDir & "\node.exe") Then
    nodeBin = appDir & "\node.exe"
ElseIf fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeBin = "C:\Program Files\nodejs\node.exe"
ElseIf fso.FileExists("C:\Program Files (x86)\nodejs\node.exe") Then
    nodeBin = "C:\Program Files (x86)\nodejs\node.exe"
Else
    nodeBin = "node"
End If

' 2. Start Background Server silently (0 = hidden)
serverJs = appDir & "\src\server.js"
WshShell.CurrentDirectory = appDir
WshShell.Run """" & nodeBin & """ """ & serverJs & """", 0, False

' 3. Wait 1.2 seconds for server startup
WScript.Sleep 1200

' 4. Launch Desktop App Window in Edge App Mode, Chrome App Mode, or Default Browser
edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
edgePath64 = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
chromePath86 = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

If fso.FileExists(edgePath) Then
    WshShell.Run """" & edgePath & """ --app=http://localhost:4587 --window-size=580,680", 1, False
ElseIf fso.FileExists(edgePath64) Then
    WshShell.Run """" & edgePath64 & """ --app=http://localhost:4587 --window-size=580,680", 1, False
ElseIf fso.FileExists(chromePath) Then
    WshShell.Run """" & chromePath & """ --app=http://localhost:4587 --window-size=580,680", 1, False
ElseIf fso.FileExists(chromePath86) Then
    WshShell.Run """" & chromePath86 & """ --app=http://localhost:4587 --window-size=580,680", 1, False
Else
    WshShell.Run "http://localhost:4587", 1, False
End If

Set WshShell = Nothing
Set fso = Nothing
