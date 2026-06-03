{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.kinome;
  json = pkgs.formats.json { };

  settingsFile = json.generate "kinome-settings.json" {
    server = {
      libraryLocation = cfg.libraryDir;
      serverPort = cfg.port;
      serverHost = cfg.host;
    };
    libraryDefaults = cfg.librarySettings;
  };

  librarySettingsFile = json.generate "kinome-library-settings.json" cfg.librarySettings;
in
{
  options.services.kinome = {
    enable = lib.mkEnableOption "Kinome media server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Kinome package to run.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "kinome";
      description = "User account for the Kinome service.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "kinome";
      description = "Group for the Kinome service.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/kinome";
      description = "Mutable Kinome data directory containing settings and library state.";
    };

    libraryDir = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.dataDir}/library";
      description = "Kinome library state directory.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address Kinome listens on.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Port Kinome listens on.";
    };

    librarySettings = lib.mkOption {
      type = json.type;
      default = { };
      description = "Initial library-settings.json content. Only seeded when the file is missing.";
    };

    memoryMax = lib.mkOption {
      type = lib.types.str;
      default = "1G";
      description = "systemd MemoryMax for Kinome.";
    };

    memoryHigh = lib.mkOption {
      type = lib.types.str;
      default = "768M";
      description = "systemd MemoryHigh for Kinome.";
    };

    cpuQuota = lib.mkOption {
      type = lib.types.str;
      default = "100%";
      description = "systemd CPUQuota for Kinome.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.${cfg.group} = { };
    users.users.${cfg.user} = {
      isSystemUser = true;
      inherit (cfg) group;
      home = cfg.dataDir;
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.libraryDir} 0750 ${cfg.user} ${cfg.group} -"
    ];

    systemd.services.kinome = {
      description = "Kinome Media Server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        KINOME_DATA = toString cfg.dataDir;
        KINOME_HOST = cfg.host;
        KINOME_PORT = toString cfg.port;
        NODE_ENV = "production";
      };

      preStart = ''
        if [ ! -e ${lib.escapeShellArg (toString cfg.dataDir)}/settings.json ]; then
          cp ${settingsFile} ${lib.escapeShellArg (toString cfg.dataDir)}/settings.json
          chmod 0640 ${lib.escapeShellArg (toString cfg.dataDir)}/settings.json
        fi

        if [ ! -e ${lib.escapeShellArg (toString cfg.libraryDir)}/library-settings.json ]; then
          cp ${librarySettingsFile} ${lib.escapeShellArg (toString cfg.libraryDir)}/library-settings.json
          chmod 0640 ${lib.escapeShellArg (toString cfg.libraryDir)}/library-settings.json
        fi
      '';

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        WorkingDirectory = "${cfg.package}/libexec/kinome";
        User = cfg.user;
        Group = cfg.group;
        Restart = "on-failure";
        RestartSec = "5s";
        MemoryMax = cfg.memoryMax;
        MemoryHigh = cfg.memoryHigh;
        CPUQuota = cfg.cpuQuota;
        CPUWeight = 50;
        TasksMax = 256;
        OOMPolicy = "stop";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
      };
    };
  };
}
