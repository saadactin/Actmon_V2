namespace ActMon.Setup.Core.Models;

public sealed class RedisConnectionInfo
{
    public string Host { get; set; } = "localhost";
    public int Port { get; set; } = 6379;
    public string Password { get; set; } = "";
}
