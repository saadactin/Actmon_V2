using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Windows port of Backend/deploy/nginx-actmon.conf — same reverse-proxy
/// topology (cloud rule before the generic API rule, gzip, immutable-asset
/// caching, SPA fallback), repointed at the ports collected in the wizard and
/// the frontend directory this installer actually deployed to.
/// </summary>
public static class NginxConfigWriter
{
    public static void Write(string confPath, InstallerContext ctx, string frontendDir)
    {
        var root = frontendDir.Replace('\\', '/');
        // AllowRemoteAccess=false binds loopback only — genuinely restricts this
        // to the local machine. AllowRemoteAccess=true binds every interface
        // (0.0.0.0), same as an unqualified "listen PORT" already did; PublicHostOrIp
        // is only ever used for display (shortcuts/summary), never for binding,
        // since binding to one specific interface IP would break access from any
        // other interface on a multi-NIC machine.
        var bindAddress = ctx.AllowRemoteAccess ? "0.0.0.0" : "127.0.0.1";
        var conf = $$"""
            worker_processes  1;
            events { worker_connections  1024; }
            http {
                include       mime.types;
                default_type  application/octet-stream;
                sendfile        on;
                gzip on;
                gzip_comp_level 5;
                gzip_min_length 1024;
                gzip_proxied any;
                gzip_types text/plain text/css application/json application/javascript text/javascript image/svg+xml application/xml font/woff2;

                server {
                    listen       {{bindAddress}}:{{ctx.FrontendPort}};
                    server_name  _;
                    root   "{{root}}";
                    index  index.html;
                    client_max_body_size 25m;

                    location /assets/ {
                        expires 30d;
                        add_header Cache-Control "public, immutable";
                        try_files $uri =404;
                    }

                    location /api/v1/cloud/ {
                        proxy_pass http://127.0.0.1:{{ctx.CloudBackendPort}};
                        proxy_set_header Host $http_host;
                        proxy_set_header X-Real-IP $remote_addr;
                        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                        proxy_read_timeout 300s;
                    }

                    location /api/ {
                        proxy_pass http://127.0.0.1:{{ctx.DatabaseBackendPort}};
                        proxy_http_version 1.1;
                        proxy_set_header Host $http_host;
                        proxy_set_header X-Real-IP $remote_addr;
                        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                        proxy_set_header Upgrade $http_upgrade;
                        proxy_set_header Connection "upgrade";
                        proxy_read_timeout 300s;
                    }

                    location / {
                        try_files $uri $uri/ /index.html;
                    }
                }
            }
            """;

        File.WriteAllText(confPath, conf);
    }
}
