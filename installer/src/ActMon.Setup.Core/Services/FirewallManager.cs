using System.Diagnostics;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Creates exactly the inbound TCP allow rules ActMon needs (section 19) — never
/// touches any other firewall rule. Rule names are all prefixed "ActMon " so they
/// are trivially identifiable (and removable) as belonging to this app alone.
/// </summary>
public sealed class FirewallManager
{
    private const string RulePrefix = "ActMon ";

    public async Task<bool> RuleExistsAsync(int port)
    {
        var (_, output) = await RunNetshAsync(new List<string> { "advfirewall", "firewall", "show", "rule", $"name={RulePrefix}Port {port}" });
        return output.Contains("----", StringComparison.Ordinal) && !output.Contains("No rules match", StringComparison.OrdinalIgnoreCase);
    }

    public async Task<bool> AddInboundRuleAsync(int port, string description)
    {
        var name = $"{RulePrefix}Port {port}";
        var (success, _) = await RunNetshAsync(new List<string>
        {
            "advfirewall", "firewall", "add", "rule",
            $"name={name}", $"description={description}",
            "dir=in", "action=allow", "protocol=TCP", $"localport={port}",
        });
        return success;
    }

    public async Task<bool> RemoveRuleAsync(int port)
    {
        var (success, _) = await RunNetshAsync(new List<string> { "advfirewall", "firewall", "delete", "rule", $"name={RulePrefix}Port {port}" });
        return success;
    }

    public async Task<List<string>> ListActMonRulesAsync()
    {
        var (_, output) = await RunNetshAsync(new List<string> { "advfirewall", "firewall", "show", "rule", $"name=all" });
        return output.Split('\n')
            .Where(l => l.TrimStart().StartsWith("Rule Name:", StringComparison.OrdinalIgnoreCase) && l.Contains(RulePrefix))
            .Select(l => l.Split(':', 2)[1].Trim())
            .ToList();
    }

    private static async Task<(bool success, string output)> RunNetshAsync(List<string> args)
    {
        var psi = new ProcessStartInfo("netsh") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi)!;
        var output = await proc.StandardOutput.ReadToEndAsync();
        await proc.WaitForExitAsync();
        return (proc.ExitCode == 0, output);
    }
}
