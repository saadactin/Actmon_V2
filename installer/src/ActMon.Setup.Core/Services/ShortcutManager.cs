using System.Runtime.InteropServices;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Creates/removes the Start Menu shortcut. Uses the Windows Script Host
/// COM automation object (late-bound via ProgID, no compile-time COM reference
/// needed) — the standard way to author a real .lnk file from .NET, since
/// there's no managed API for it. ActMon itself is a web app reached through a
/// browser, so the shortcut opens its URL via explorer.exe rather than
/// launching a desktop window; its icon still points at ActMon.exe's own
/// embedded icon so it's instantly recognizable next to other Start Menu tiles.
/// </summary>
public sealed class ShortcutManager
{
    private static string StartMenuPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), "Programs", "ActMon.lnk");

    public void CreateStartMenuShortcut(string exePath, string url)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("WScript.Shell COM component is not available.");
        dynamic shell = Activator.CreateInstance(shellType)!;
        try
        {
            dynamic shortcut = shell.CreateShortcut(StartMenuPath);
            try
            {
                shortcut.TargetPath = Environment.ExpandEnvironmentVariables(@"%SystemRoot%\explorer.exe");
                shortcut.Arguments = $"\"{url}\"";
                shortcut.IconLocation = $"{exePath},0";
                shortcut.Description = "Open ActMon";
                shortcut.Save();
            }
            finally
            {
                Marshal.FinalReleaseComObject(shortcut);
            }
        }
        finally
        {
            Marshal.FinalReleaseComObject(shell);
        }
    }

    public void RemoveStartMenuShortcut()
    {
        if (File.Exists(StartMenuPath))
            File.Delete(StartMenuPath);
    }
}
