using System.Linq;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.PortConfiguration;

public sealed class PortConfigurationViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private bool _canGoNext;

    public PortConfigurationViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        var checker = new PortChecker();

        Frontend = new PortRowViewModel("Frontend / Nginx", ctx.FrontendPort, checker, Recompute, "nginx.exe", InstallEngine.FrontendServiceName);
        DatabaseBackend = new PortRowViewModel("Database Backend", ctx.DatabaseBackendPort, checker, Recompute, "actmon-database-server.exe", InstallEngine.DatabaseServiceName);
        CloudBackend = new PortRowViewModel("Cloud Backend", ctx.CloudBackendPort, checker, Recompute, "actmon-cloud-server.exe", InstallEngine.CloudServiceName);

        // A detected local IP is only ever a starting suggestion — never
        // authoritative (multi-NIC machines, NAT, cloud floating/public IPs
        // all make "the" local address ambiguous) — the administrator can
        // freely overwrite it.
        if (string.IsNullOrWhiteSpace(_ctx.PublicHostOrIp))
            _ctx.PublicHostOrIp = DetectLikelyLocalIPv4() ?? "";
    }

    public PortRowViewModel Frontend { get; }
    public PortRowViewModel DatabaseBackend { get; }
    public PortRowViewModel CloudBackend { get; }

    public bool AllowRemoteAccess
    {
        get => _ctx.AllowRemoteAccess;
        set
        {
            if (_ctx.AllowRemoteAccess == value) return;
            _ctx.AllowRemoteAccess = value;
            OnPropertyChanged();
        }
    }

    public string PublicHostOrIp
    {
        get => _ctx.PublicHostOrIp;
        set
        {
            if (_ctx.PublicHostOrIp == value) return;
            _ctx.PublicHostOrIp = value;
            OnPropertyChanged();
        }
    }

    // Host-only/NAT adapters from VirtualBox, VMware, Hyper-V, WSL, and VPN/
    // tunnel software all show up as ordinary "Up" IPv4-carrying interfaces —
    // indistinguishable from a real LAN NIC by type or status alone. Their
    // addresses are only reachable from other VMs on the same virtual switch,
    // never from a real machine elsewhere on the network, so a real Ethernet/
    // Wi-Fi adapter is strongly preferred whenever one is available. Confirmed
    // directly: without this filter, the suggestion picked a VirtualBox
    // host-only address (192.168.56.x) over the machine's actual LAN IP.
    private static readonly string[] VirtualAdapterMarkers =
    {
        "virtual", "vbox", "virtualbox", "vmware", "hyper-v", "hyperv", "wsl",
        "vpn", "tunnel", "tap-", "tap ", "npcap", "loopback", "bluetooth", "docker",
    };

    private static string? DetectLikelyLocalIPv4()
    {
        try
        {
            var candidates = NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                .Select(n => new
                {
                    Iface = n,
                    IsPhysicalType = n.NetworkInterfaceType is NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211,
                    LooksVirtual = VirtualAdapterMarkers.Any(m =>
                        n.Description.Contains(m, StringComparison.OrdinalIgnoreCase) ||
                        n.Name.Contains(m, StringComparison.OrdinalIgnoreCase)),
                    Address = n.GetIPProperties().UnicastAddresses
                        .Select(a => a.Address)
                        .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork),
                })
                .Where(c => c.Address is not null)
                .OrderByDescending(c => c.IsPhysicalType && !c.LooksVirtual)  // real NIC, not virtual — best
                .ThenByDescending(c => !c.LooksVirtual)                       // at least not virtual
                .ThenByDescending(c => c.IsPhysicalType);                     // at least a physical type

            return candidates.FirstOrDefault()?.Address?.ToString();
        }
        catch
        {
            return null;
        }
    }

    public bool CanGoNext
    {
        get => _canGoNext;
        private set
        {
            if (SetField(ref _canGoNext, value))
                CanGoNextChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    public event EventHandler? CanGoNextChanged;

    public async Task OnNavigatedToAsync()
    {
        await Task.WhenAll(Frontend.RecheckAsync(), DatabaseBackend.RecheckAsync(), CloudBackend.RecheckAsync());
    }

    private void Recompute()
    {
        _ctx.FrontendPort = Frontend.Port;
        _ctx.DatabaseBackendPort = DatabaseBackend.Port;
        _ctx.CloudBackendPort = CloudBackend.Port;
        // A port held by a genuine foreign process still blocks Next (the
        // spec is explicit that nothing gets killed automatically) — but one
        // held by ActMon's own already-running service (left behind by an
        // earlier attempt that started services but didn't finish, or by
        // Modify/Repair/Upgrade re-running over a live install) isn't a
        // conflict: Install stops and replaces those exact same services
        // before redeploying, so blocking Next here would just be a dead end.
        CanGoNext = Frontend.IsUsable && DatabaseBackend.IsUsable && CloudBackend.IsUsable;
    }
}
