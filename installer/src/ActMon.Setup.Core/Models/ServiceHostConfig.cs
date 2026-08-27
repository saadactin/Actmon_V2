using System.Text.Json;
using System.Text.Json.Serialization;

namespace ActMon.Setup.Core.Models;

/// <summary>
/// Written once by the installer's Install step for each backend it registers as
/// a Windows Service — sits next to ActMon.ServiceHost.exe as its own
/// "*.config.json" (path passed via --config). Keeping config in a plain file the
/// installer writes, instead of baking per-service values into the exe, is what
/// lets one ActMon.ServiceHost.exe binary be reused for the database backend, the
/// cloud backend and nginx alike.
/// </summary>
public sealed class ServiceHostConfig
{
    public required string ExecutablePath { get; init; }
    public required string WorkingDirectory { get; init; }
    public required string LogDirectory { get; init; }
    public Dictionary<string, string> EnvironmentVariables { get; init; } = new();

    public static ServiceHostConfig Load(string path)
    {
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<ServiceHostConfig>(json, JsonOptions)
               ?? throw new InvalidOperationException($"Could not parse service host config at {path}");
    }

    public void Save(string path) => File.WriteAllText(path, JsonSerializer.Serialize(this, JsonOptions));

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
