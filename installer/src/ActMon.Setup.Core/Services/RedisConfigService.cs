using ActMon.Setup.Core.Models;
using StackExchange.Redis;

namespace ActMon.Setup.Core.Services;

/// <summary>Real Redis connection testing for section 10. Redis itself (via WSL2 +
/// Ubuntu) is provisioned separately by the Install stage — this only ever reads,
/// never flushes or resets credentials.</summary>
public sealed class RedisConfigService
{
    public async Task<(bool success, string message)> TestConnectionAsync(RedisConnectionInfo info)
    {
        var options = new ConfigurationOptions
        {
            EndPoints = { { info.Host, info.Port } },
            Password = string.IsNullOrEmpty(info.Password) ? null : info.Password,
            ConnectTimeout = 5000,
            AbortOnConnectFail = false,
        };

        try
        {
            await using var conn = await ConnectionMultiplexer.ConnectAsync(options);
            if (!conn.IsConnected)
                return (false, "Could not establish a connection.");

            var db = conn.GetDatabase();
            var latency = await db.PingAsync();
            var server = conn.GetServer(info.Host, info.Port);
            var version = server.IsConnected ? server.Version.ToString() : "unknown";
            return (true, $"Connected — Redis {version}, ping {latency.TotalMilliseconds:F0}ms");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }
}
