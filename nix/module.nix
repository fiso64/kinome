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
  gocoderDir = "${cfg.dataDir}/gocoder";
  databaseSocket = "/run/kinome-gocoder/postgres";
  defaultMediaRoot = "${cfg.dataDir}/media";
  declaredMediaRoots = map (source:
    if (source.isRelative or false) || !lib.hasPrefix "/" source.path
    then "${builtins.dirOf cfg.libraryDir}/${source.path}"
    else source.path
  ) (builtins.filter (source: (source.path or "") != "") (cfg.librarySettings.mediaSources or [ ]));
  mediaRoots = lib.unique (map (root: toString (/. + root)) cfg.gocoder.mediaRoots);
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

    gocoder = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Run the managed playback conversion worker and its private database.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 7666;
        description = "Loopback port for the playback conversion worker.";
      };

      mediaRoots = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ defaultMediaRoot ] ++ declaredMediaRoots;
        description = "Read-only media roots available to gocoder. Add roots configured interactively if outside the declared paths.";
      };
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

    assertions = lib.optional cfg.gocoder.enable {
      assertion = lib.all (root: lib.hasPrefix "/" root && !lib.hasInfix ":" root) cfg.gocoder.mediaRoots
        && !builtins.elem "/" mediaRoots;
      message = "services.kinome.gocoder.mediaRoots must contain absolute media paths other than /, with no colon characters.";
    };

    virtualisation.oci-containers.containers = lib.mkIf cfg.gocoder.enable {
      kinome-gocoder-db = {
        serviceName = "kinome-gocoder-db";
        image = "docker.io/library/postgres:17-alpine@sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32";
        environment = {
          POSTGRES_USER = "gocoder";
          POSTGRES_HOST_AUTH_METHOD = "trust";
        };
        # The database is reachable only through the shared socket directory.
        extraOptions = [ "--network=none" ];
        cmd = [ "-c" "listen_addresses=" ];
        volumes = [
          "${gocoderDir}/postgres:/var/lib/postgresql/data"
          "${databaseSocket}:/var/run/postgresql"
        ];
      };

      kinome-gocoder = {
        serviceName = "kinome-gocoder";
        image = "ghcr.io/zoriya/kyoo_transcoder:5.3.0@sha256:1171f5001e10a082db3da7e12f4b9ac958feb1e51d9a4a62a392c50a3e2fab4b";
        dependsOn = [ "kinome-gocoder-db" ];
        ports = [ "127.0.0.1:${toString cfg.gocoder.port}:7666" ];
        environment.POSTGRES_URL = "postgresql://gocoder@localhost/gocoder?host=/var/run/postgresql&sslmode=disable";
        volumes = [
          "${gocoderDir}/cache:/cache"
          "${gocoderDir}/metadata:/metadata"
          "${databaseSocket}:/var/run/postgresql:ro"
        ] ++ map (root: "${root}:/video${root}:ro") mediaRoots;
      };
    };

    systemd.services.kinome-gocoder-db = lib.mkIf cfg.gocoder.enable {
      after = [ "systemd-tmpfiles-setup.service" ];
      unitConfig.RequiresMountsFor = [ cfg.dataDir ];
      # Create both containers' bind mounts before the OCI service tries to start.
      preStart = lib.mkBefore ''
        ${lib.getExe' pkgs.coreutils "install"} -d -m 0750 -o ${lib.escapeShellArg cfg.user} -g ${lib.escapeShellArg cfg.group} ${lib.escapeShellArg defaultMediaRoot}
        ${lib.getExe' pkgs.coreutils "mkdir"} -p -m 0700 ${lib.escapeShellArgs [
          gocoderDir "${gocoderDir}/cache" "${gocoderDir}/metadata" "${gocoderDir}/postgres" "/run/kinome-gocoder"
        ]}
        ${lib.getExe' pkgs.coreutils "mkdir"} -p -m 0777 ${lib.escapeShellArg databaseSocket}
      '';
      serviceConfig.RestartSec = "5s";
    };

    systemd.services.kinome-gocoder = lib.mkIf cfg.gocoder.enable {
      # Gocoder can exit successfully if its DB is still initializing.
      serviceConfig.Restart = lib.mkForce "always";
      serviceConfig.RestartSec = "5s";
    };

    systemd.services.kinome = {
      description = "Kinome Media Server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ] ++ lib.optional cfg.gocoder.enable "kinome-gocoder.service";

      environment = {
        KINOME_DATA = toString cfg.dataDir;
        KINOME_HOST = cfg.host;
        KINOME_PORT = toString cfg.port;
        NODE_ENV = "production";
      } // lib.optionalAttrs cfg.gocoder.enable {
        KINOME_GOCODER_URL = "http://127.0.0.1:${toString cfg.gocoder.port}";
        KINOME_GOCODER_ROOTS = builtins.toJSON mediaRoots;
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
