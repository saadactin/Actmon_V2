namespace ActMon.Setup.Models;

/// <summary>Exact flow from the installer spec, section 3.</summary>
public enum WizardStepId
{
    Welcome,
    SystemRequirements,
    DependencyPreCheck,
    PortConfiguration,
    PostgreSqlConfiguration,
    RedisConfiguration,
    ClickHouseConfiguration,
    OrganizationSetup,
    SuperAdminSetup,
    SmtpConfiguration,
    ApplicationConfiguration,
    ConfigurationSummary,
    Install,
    WindowsServices,
    Firewall,
    HealthCheck,
    InstallationComplete,
}
