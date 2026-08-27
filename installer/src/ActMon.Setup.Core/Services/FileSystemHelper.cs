using System.Diagnostics;

namespace ActMon.Setup.Core.Services;

public static class FileSystemHelper
{
    public static void CopyDirectory(string sourceDir, string destDir)
    {
        Directory.CreateDirectory(destDir);
        foreach (var dir in Directory.GetDirectories(sourceDir, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(dir.Replace(sourceDir, destDir));

        foreach (var file in Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories))
            File.Copy(file, file.Replace(sourceDir, destDir), overwrite: true);
    }

    /// <summary>
    /// Section 16 — configuration files containing secrets must use restrictive
    /// ACLs. Grants only SYSTEM and Administrators, removing inherited access
    /// every other locally-authenticated user would otherwise have.
    /// </summary>
    public static void RestrictToAdministrators(string filePath)
    {
        var psi = new ProcessStartInfo("icacls")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add(filePath);
        psi.ArgumentList.Add("/inheritance:r");
        psi.ArgumentList.Add("/grant:r");
        psi.ArgumentList.Add("SYSTEM:F");
        psi.ArgumentList.Add("/grant:r");
        psi.ArgumentList.Add("*S-1-5-32-544:F"); // Administrators (well-known SID — locale independent)

        using var proc = Process.Start(psi)!;
        proc.WaitForExit();
    }
}
