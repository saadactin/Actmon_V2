namespace ActMon.Setup.Core.Models;

/// <summary>Where every prebuilt artifact the Install step deploys actually lives —
/// resolved by the caller so InstallEngine itself doesn't hardcode dev-vs-packaged
/// layout assumptions.</summary>
public sealed class InstallPayload
{
    public required string DatabaseServerDir { get; init; }   // contains actmon-database-server.exe
    public required string CloudServerDir { get; init; }       // contains actmon-cloud-server.exe
    public required string DbSetupExePath { get; init; }       // actmon-db-setup.exe — PyInstaller onedir build; its whole containing folder (including "_internal") is deployed, not just this exe
    public required string NginxDir { get; init; }              // contains nginx.exe + conf/
    public required string FrontendDistDir { get; init; }       // built frontend/dist contents
    public required string ServiceHostExePath { get; init; }    // ActMon.ServiceHost.exe — framework-dependent build; its whole containing folder (dll, deps.json, dependency assemblies) is deployed, not just this exe
    public required string AgentDistDir { get; init; }          // pre-built actmon-agent.exe/.msi/.deb/.rpm — the database backend serves these for its own "download agent" feature from <its own dir>/agent/dist
}
