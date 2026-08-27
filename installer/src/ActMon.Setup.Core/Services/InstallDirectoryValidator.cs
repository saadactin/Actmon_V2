namespace ActMon.Setup.Core.Services;

public enum InstallDirectoryStatus
{
    Ok,
    LowDiskSpaceWarning,
    Invalid,
}

public sealed record InstallDirectoryCheck(InstallDirectoryStatus Status, string Message, double FreeSpaceGb);

/// <summary>
/// Validates a user-chosen (or default) install directory: creates it if it
/// doesn't exist yet, confirms it's actually writable by the account running
/// this installer, and checks free disk space on its drive against the same
/// thresholds System Requirements uses. Used by the Welcome/Application
/// Configuration page so a bad path is caught immediately rather than surfacing
/// as an obscure I/O failure deep into Install.
/// </summary>
public static class InstallDirectoryValidator
{
    public static InstallDirectoryCheck Validate(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return new InstallDirectoryCheck(InstallDirectoryStatus.Invalid, "Enter an installation directory.", 0);

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path);
        }
        catch (Exception ex)
        {
            return new InstallDirectoryCheck(InstallDirectoryStatus.Invalid, $"Not a valid path ({ex.Message}).", 0);
        }

        try
        {
            Directory.CreateDirectory(fullPath);
        }
        catch (Exception ex)
        {
            return new InstallDirectoryCheck(InstallDirectoryStatus.Invalid, $"Could not create this directory ({ex.Message}). Choose a different location.", 0);
        }

        try
        {
            var probeFile = Path.Combine(fullPath, $".actmon-write-check-{Guid.NewGuid():N}.tmp");
            File.WriteAllText(probeFile, "");
            File.Delete(probeFile);
        }
        catch (Exception ex)
        {
            return new InstallDirectoryCheck(InstallDirectoryStatus.Invalid, $"This directory is not writable ({ex.Message}). Run as Administrator or choose a different location.", 0);
        }

        double freeGb;
        try
        {
            var root = Path.GetPathRoot(fullPath) ?? "C:\\";
            freeGb = new DriveInfo(root).AvailableFreeSpace / 1024.0 / 1024.0 / 1024.0;
        }
        catch (Exception ex)
        {
            return new InstallDirectoryCheck(InstallDirectoryStatus.Invalid, $"Could not check free disk space ({ex.Message}).", 0);
        }

        if (freeGb < SystemRequirementsChecker.MinFreeDiskGb)
        {
            return new InstallDirectoryCheck(InstallDirectoryStatus.Invalid,
                $"Only {freeGb:F1} GB free — at least {SystemRequirementsChecker.MinFreeDiskGb:F0} GB is required for ActMon, PostgreSQL and ClickHouse data.", freeGb);
        }

        if (freeGb < SystemRequirementsChecker.WarnFreeDiskGb)
        {
            return new InstallDirectoryCheck(InstallDirectoryStatus.LowDiskSpaceWarning,
                $"{freeGb:F1} GB free — usable, but comfortable headroom is {SystemRequirementsChecker.WarnFreeDiskGb:F0}+ GB once monitoring data accumulates.", freeGb);
        }

        return new InstallDirectoryCheck(InstallDirectoryStatus.Ok, $"{freeGb:F1} GB free.", freeGb);
    }
}
