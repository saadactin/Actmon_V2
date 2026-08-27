using ActMon.ServiceHost;
using ActMon.Setup.Core.Models;

var configPath = "servicehost.config.json";
for (var i = 0; i < args.Length - 1; i++)
{
    if (args[i] is "--config" or "-c")
    {
        configPath = args[i + 1];
        break;
    }
}

if (!Path.IsPathRooted(configPath))
    configPath = Path.Combine(AppContext.BaseDirectory, configPath);

var config = ServiceHostConfig.Load(configPath);

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddSingleton(config);
builder.Services.AddHostedService<Worker>();
builder.Services.AddWindowsService(o => o.ServiceName = Path.GetFileNameWithoutExtension(config.ExecutablePath));
builder.Logging.AddEventLog();

var host = builder.Build();
host.Run();
