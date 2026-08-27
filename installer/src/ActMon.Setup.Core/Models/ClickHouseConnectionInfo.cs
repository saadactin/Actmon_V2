namespace ActMon.Setup.Core.Models;

public sealed class ClickHouseConnectionInfo
{
    public string Host { get; set; } = "localhost";
    public int Port { get; set; } = 8123;
    public string Username { get; set; } = "default";
    public string Password { get; set; } = "";
    public string Database { get; set; } = "default";
}
