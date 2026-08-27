using Microsoft.Win32;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Registers ActMon under Windows' "Apps &amp; features" / Add-Remove Programs
/// (HKLM\...\Uninstall\ActMon) so it's listed and its Uninstall button re-runs
/// this same ActMon.exe — which, once copied into the install directory,
/// detects the install manifest and routes straight to the Uninstall screen
/// (see RootViewModel) exactly as if launched manually.
/// </summary>
public sealed class AddRemoveProgramsManager
{
    private const string KeyPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ActMon";

    public void Register(string installDirectory, string installedExePath, string version, int estimatedSizeKb)
    {
        using var key = Registry.LocalMachine.CreateSubKey(KeyPath);
        key.SetValue("DisplayName", "ActMon");
        key.SetValue("DisplayVersion", version);
        key.SetValue("Publisher", "ACTIN");
        key.SetValue("DisplayIcon", $"{installedExePath},0");
        key.SetValue("InstallLocation", installDirectory);
        // Re-launches ActMon.exe, which detects the install manifest and routes
        // straight to the Modify/Repair/Upgrade/Uninstall screen (RootViewModel) —
        // there is no separate silent/quiet uninstall mode, so only this is set.
        key.SetValue("UninstallString", $"\"{installedExePath}\"");
        key.SetValue("NoModify", 0, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        key.SetValue("EstimatedSize", estimatedSizeKb, RegistryValueKind.DWord);
    }

    public void Unregister()
    {
        Registry.LocalMachine.DeleteSubKeyTree(KeyPath, throwOnMissingSubKey: false);
    }
}
