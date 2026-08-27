using System.Diagnostics;
using System.ServiceProcess;

namespace ActMon.Setup.Core.Services;

public sealed record ServiceRegistration(string ServiceName, string DisplayName, string BinaryPath, string[] Arguments);

/// <summary>
/// Registers/starts/stops/removes Windows Services via sc.exe (ServiceController
/// can only control existing services, not create them — creation needs either
/// sc.exe or the raw CreateService Win32 API; sc.exe is the simpler, well-tested
/// route). Each ArgumentList entry becomes its own argv element, which is exactly
/// how sc.exe expects "binPath=" and its value to arrive as separate tokens.
/// </summary>
public sealed class WindowsServiceManager
{
    public async Task<(bool success, string output)> CreateAsync(ServiceRegistration reg)
    {
        var quotedArgs = string.Join(" ", reg.Arguments.Select(a => $"\"{a}\""));
        var binPathValue = $"\"{reg.BinaryPath}\" {quotedArgs}".TrimEnd();

        var args = new List<string> { "create", reg.ServiceName, "binPath=", binPathValue, "start=", "auto", "DisplayName=", reg.DisplayName };
        return await RunScAsync(args);
    }

    public Task<(bool success, string output)> SetDescriptionAsync(string serviceName, string description) =>
        RunScAsync(new List<string> { "description", serviceName, description });

    public Task<(bool success, string output)> SetFailureActionsAsync(string serviceName) =>
        // restart/restart/restart, 1s delay, reset failure count after 24h — "Restart on failure" from section 18.
        RunScAsync(new List<string> { "failure", serviceName, "reset=", "86400", "actions=", "restart/1000/restart/1000/restart/1000" });

    public async Task<bool> DeleteAsync(string serviceName)
    {
        try
        {
            using var sc = new ServiceController(serviceName);
            if (sc.Status != ServiceControllerStatus.Stopped)
            {
                sc.Stop();
                sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
            }
        }
        catch { /* not installed / already stopped */ }

        var (success, _) = await RunScAsync(new List<string> { "delete", serviceName });
        return success;
    }

    public bool Exists(string serviceName)
    {
        try
        {
            using var sc = new ServiceController(serviceName);
            _ = sc.Status;
            return true;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> StartAsync(string serviceName, TimeSpan timeout)
    {
        using var sc = new ServiceController(serviceName);
        if (sc.Status == ServiceControllerStatus.Running) return true;

        return await Task.Run(() =>
        {
            try
            {
                // sc.Start() itself can throw — the Service Control Manager has its
                // own internal "did this service report RUNNING in time" timeout
                // (separate from, and outside, the `timeout` parameter below) and
                // raises Win32Exception 1053 if it gives up. Left uncaught, this
                // used to bubble all the way out of Install as a generic
                // "unexpected error" instead of surfacing as this specific
                // service's own clear failure message.
                sc.Start();
                sc.WaitForStatus(ServiceControllerStatus.Running, timeout);
                return true;
            }
            catch (System.ServiceProcess.TimeoutException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        });
    }

    public ServiceControllerStatus? GetStatus(string serviceName)
    {
        try
        {
            using var sc = new ServiceController(serviceName);
            sc.Refresh();
            return sc.Status;
        }
        catch
        {
            return null;
        }
    }

    private static async Task<(bool success, string output)> RunScAsync(List<string> args)
    {
        var psi = new ProcessStartInfo("sc.exe") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi)!;
        var stdout = await proc.StandardOutput.ReadToEndAsync();
        var stderr = await proc.StandardError.ReadToEndAsync();
        await proc.WaitForExitAsync();
        return (proc.ExitCode == 0, stdout + stderr);
    }
}
