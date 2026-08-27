using System.Diagnostics;
using System.Net.Http;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Downloads and silently installs the official EnterpriseDB PostgreSQL Windows
/// build (section 8, Case A) — the same distributable EDB itself points users
/// at, run with its own documented unattended-mode flags. Only used when
/// DependencyDetector already found no PostgreSQL service at all; an existing
/// install is never touched.
/// </summary>
public sealed class PostgresInstaller
{
    public const string DefaultVersion = "16.4-1";

    public async Task<(bool success, string message)> DownloadAndInstallAsync(
        string superuserPassword, string serviceName, int port, Action<string> onProgress, string version = DefaultVersion)
    {
        var url = $"https://get.enterprisedb.com/postgresql/postgresql-{version}-windows-x64.exe";
        var installerPath = Path.Combine(Path.GetTempPath(), $"postgresql-{version}-windows-x64.exe");

        try
        {
            onProgress($"Downloading PostgreSQL {version}...");
            using (var http = new HttpClient { Timeout = TimeSpan.FromMinutes(15) })
            using (var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
            {
                response.EnsureSuccessStatusCode();
                await using var fileStream = File.Create(installerPath);
                await response.Content.CopyToAsync(fileStream);
            }

            onProgress("Installing PostgreSQL (unattended)...");
            var psi = new ProcessStartInfo(installerPath)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.ArgumentList.Add("--mode");
            psi.ArgumentList.Add("unattended");
            psi.ArgumentList.Add("--unattendedmodeui");
            psi.ArgumentList.Add("minimal");
            psi.ArgumentList.Add("--superpassword");
            psi.ArgumentList.Add(superuserPassword);
            psi.ArgumentList.Add("--servicename");
            psi.ArgumentList.Add(serviceName);
            psi.ArgumentList.Add("--serverport");
            psi.ArgumentList.Add(port.ToString());
            psi.ArgumentList.Add("--disable-components");
            psi.ArgumentList.Add("stackbuilder");

            using var proc = Process.Start(psi)!;
            var stdout = await proc.StandardOutput.ReadToEndAsync();
            var stderr = await proc.StandardError.ReadToEndAsync();
            await proc.WaitForExitAsync();

            File.Delete(installerPath);

            return proc.ExitCode == 0
                ? (true, "PostgreSQL installed.")
                : (false, $"Installer exited with code {proc.ExitCode}.\n{stdout}\n{stderr}");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }
}
