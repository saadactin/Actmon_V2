using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Real port-availability checks for section 7. Tries an actual bind first (the
/// only fully reliable test); when that fails, shells out to `netstat -ano` to
/// identify the owning PID/process so the wizard can show — never silently
/// kill — what's holding the port, per the spec's "never kill an existing
/// process automatically" rule.
/// </summary>
public sealed class PortChecker
{
    public Task<PortCheckResult> CheckAsync(int port) => Task.Run(() =>
    {
        if (TryBind(port))
        {
            return new PortCheckResult { Port = port, IsAvailable = true };
        }

        var (pid, name) = FindOwner(port);
        return new PortCheckResult { Port = port, IsAvailable = false, Pid = pid, ProcessName = name };
    });

    private static bool TryBind(int port)
    {
        try
        {
            using var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    private static (int? pid, string? name) FindOwner(int port)
    {
        try
        {
            var psi = new ProcessStartInfo("netstat", "-ano -p TCP")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi)!;
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(5000);

            foreach (var line in output.Split('\n'))
            {
                // "  TCP    0.0.0.0:9182           0.0.0.0:0              LISTENING       12345"
                var m = Regex.Match(line, @"^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)", RegexOptions.IgnoreCase);
                if (!m.Success || m.Groups[1].Value != port.ToString()) continue;

                var pid = int.Parse(m.Groups[2].Value);
                try
                {
                    using var process = Process.GetProcessById(pid);
                    return (pid, process.ProcessName + ".exe");
                }
                catch
                {
                    return (pid, null);
                }
            }
        }
        catch
        {
            // fall through — we still know it's unavailable, just not by whom
        }

        return (null, null);
    }
}
