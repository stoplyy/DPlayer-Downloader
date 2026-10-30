; Release defines are generated from release/config.json by build.ps1.
#include ConfigInclude

[Setup]
AppId={{7E7AA473-593E-4D75-97A7-4E13661AE8AB}
#ifndef DevelopmentBuild
AppName={#ProductName} Host
#ifndef UnsignedBuild
SignTool=frame
SignedUninstaller=yes
#endif
#else
AppName={#ProductName} Host (DEVELOPMENT - DO NOT DISTRIBUTE)
#endif
AppVersion={#HostVersion}
AppPublisher={#Publisher}
AppSupportURL={#SupportUrl}
AppUpdatesURL={#ReleaseUrl}
DefaultDirName={localappdata}\FrameVideoDownloader\app
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
OutputDir={#OutputDir}
#ifndef DevelopmentBuild
OutputBaseFilename=frame-video-downloader-host-{#HostVersion}-windows-x64
#else
OutputBaseFilename=frame-video-downloader-host-{#HostVersion}-DEVELOPMENT-compile-check
#endif
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\native-host.exe
CloseApplications=yes
CloseApplicationsFilter=native-host.exe,yt-dlp.exe,ffmpeg.exe,ffprobe.exe
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Inno's file transaction includes the staged manifest and rollback.
Source: "{tmp}\{#HostName}.json"; DestDir: "{app}"; Flags: external ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueData: "{app}\{#HostName}.json"; Flags: uninsdeletekey
#if ChromeId != ""
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueData: "{app}\{#HostName}.json"; Flags: uninsdeletekey
#endif

[Run]
Filename: "{#ReleaseUrl}"; Description: "Open help, then return to the extension and click Retry connection"; Flags: shellexec postinstall skipifsilent unchecked

[Code]
function JsonString(Value: String): String;
var I: Integer;
begin
  Result := '"';
  for I := 1 to Length(Value) do begin
    if (Ord(Value[I]) < 32) or (Ord(Value[I]) > 126) then
      Result := Result + Format('\u%.4x', [Ord(Value[I])])
    else begin
      if (Value[I] = '\') or (Value[I] = '"') then Result := Result + '\';
      Result := Result + Value[I];
    end;
  end;
  Result := Result + '"';
end;

function StopInstalledHosts(): String;
var Locator, Services, Processes, Process: Variant; I: Integer; AppPath, ToolPath, ProcessPath: String;
begin
  Result := '';
  AppPath := ExpandConstant('{app}\native-host.exe');
  ToolPath := ExpandConstant('{app}\tools\');
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT * FROM Win32_Process WHERE Name="yt-dlp.exe" OR Name="ffmpeg.exe" OR Name="ffprobe.exe"');
    for I := 0 to Processes.Count - 1 do begin
      Process := Processes.ItemIndex(I);
      if not VarIsNull(Process.ExecutablePath) then begin
        ProcessPath := Process.ExecutablePath;
        if Pos(Lowercase(ToolPath), Lowercase(ProcessPath)) = 1 then begin
          Result := 'A download is running. Pause tasks and stop the local service in the extension, then retry.';
          Exit;
        end;
      end;
    end;
    Processes := Services.ExecQuery('SELECT * FROM Win32_Process WHERE Name="native-host.exe"');
    for I := 0 to Processes.Count - 1 do begin
      Process := Processes.ItemIndex(I);
      if not VarIsNull(Process.ExecutablePath) then begin
        ProcessPath := Process.ExecutablePath;
        if CompareText(ProcessPath, AppPath) = 0 then
          if Process.Terminate() <> 0 then begin
            Result := 'Please stop the local service in your extension and retry.';
            Exit;
          end;
      end;
    end;
  except
    Result := 'Unable to check running downloads. Close the browser and retry; contact support if this persists.';
  end;
end;

function NewerInstalledVersion(Installed, Proposed: String): Boolean;
var I, P, LeftPart, RightPart: Integer;
begin
  Result := False;
  for I := 1 to 3 do begin
    P := Pos('.', Installed + '.');
    LeftPart := StrToIntDef(Copy(Installed, 1, P - 1), 0);
    Delete(Installed, 1, P);
    P := Pos('.', Proposed + '.');
    RightPart := StrToIntDef(Copy(Proposed, 1, P - 1), 0);
    Delete(Proposed, 1, P);
    if LeftPart <> RightPart then begin
      Result := LeftPart > RightPart;
      Exit;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Manifest, InstalledVersion: String;
begin
  Result := '';
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7E7AA473-593E-4D75-97A7-4E13661AE8AB}_is1', 'DisplayVersion', InstalledVersion) then
    if NewerInstalledVersion(InstalledVersion, '{#HostVersion}') then begin
      Result := 'A newer Host is already installed. Use the latest installer; downgrades are blocked.';
      Exit;
    end;
  Result := StopInstalledHosts();
  if Result <> '' then Exit;
  Manifest := '{"name":"{#HostName}","description":"Frame Video Downloader Host","type":"stdio","path":' +
    JsonString(ExpandConstant('{app}\native-host.exe')) + ',"allowed_origins":[' + JsonString('chrome-extension://{#EdgeId}/');
#if ChromeId != ""
  Manifest := Manifest + ',' + JsonString('chrome-extension://{#ChromeId}/');
#endif
  Manifest := Manifest + ']}';
  { JSON is ASCII with Unicode escapes, therefore also valid BOM-free UTF-8. }
  if not SaveStringToFile(ExpandConstant('{tmp}\{#HostName}.json'), Manifest, False) then
    Result := 'Unable to prepare Native Messaging registration. No registration was changed.';
end;

function InitializeUninstall(): Boolean;
var Reason: String;
begin
  Reason := StopInstalledHosts();
  Result := Reason = '';
  if not Result then MsgBox(Reason, mbError, MB_OK);
end;

procedure InitializeWizard();
begin
  WizardForm.WelcomeLabel2.Caption :=
    'Installs the local download service, yt-dlp and FFmpeg/ffprobe for this Windows user.' + #13#10#13#10 +
    'Registers Native Messaging for the confirmed store extension. Install the browser extension separately from its official store.' + #13#10#13#10 +
    'Updates and uninstall preserve downloads, task history and settings. No administrator permission is requested.';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent then
    MsgBox('Local component removed. Downloads, task history and settings were kept. Remove browser extensions separately. See the installation guide for optional data cleanup.', mbInformation, MB_OK);
end;
