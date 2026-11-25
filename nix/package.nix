{ lib
, stdenv
, bun2nix
, bun
, go
, git
, zip
, makeWrapper
, ffmpeg-headless
, fetchurl
}:

let
  packageJson = lib.importJSON ../package.json;

  # Jellyfin's web client, for Jellyfin apps that open the server's own. Fetched once per pinned release.
  jellyfinRelease = lib.importJSON ../src/main/jellyfin/web-release.json;
  jellyfinArchive = fetchurl { inherit (jellyfinRelease) url sha256; };

  bunTarget = {
    x86_64-linux = "bun-linux-x64";
    aarch64-linux = "bun-linux-arm64";
  }.${stdenv.hostPlatform.system} or (throw "Unsupported Kinome target: ${stdenv.hostPlatform.system}");
in
bun2nix.mkDerivation {
  pname = "kinome";
  version = packageJson.version;

  src = lib.cleanSourceWith {
    src = lib.cleanSource ../.;
    filter = name: type:
      let base = baseNameOf name;
      in !(lib.elem base [
        ".git"
        "dist"
        "node_modules"
        "out"
        "nfpm.temp.yaml"
        "jellyfin-web"
      ]);
  };

  packageJson = ../package.json;
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../bun.nix;
  };

  nativeBuildInputs = [ bun go git zip makeWrapper ];

  # Bun compiled executables append the application payload to the Bun runtime.
  # Nix's default strip phase removes that payload, leaving a plain `bun` binary.
  dontStrip = true;

  preBuild = ''
    export HOME=$TMPDIR
    export GOCACHE=$TMPDIR/go-cache
    export GOPATH=$TMPDIR/go
  '';

  buildPhase = ''
    runHook preBuild

    mkdir -p public/bin dist
    bun run build:handler
    bun run build
    bun build --compile --target=${bunTarget} --minify --sourcemap \
      --define "process.env.NODE_ENV='production'" \
      ./src/main/server.ts \
      --outfile dist/kinome

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/libexec/kinome
    install -Dm755 dist/kinome $out/libexec/kinome/kinome
    cp -r out public $out/libexec/kinome/
    mkdir -p $out/libexec/kinome/vendor
    tar -xJf ${jellyfinArchive} -C $out/libexec/kinome/vendor --strip-components=1 jellyfin/jellyfin-web
    makeWrapper $out/libexec/kinome/kinome $out/bin/kinome \
      --prefix PATH : ${lib.makeBinPath [ ffmpeg-headless ]}

    runHook postInstall
  '';

  meta = {
    description = "A media server and manager";
    homepage = "https://github.com/fiso64/kinome";
    license = lib.licenses.mit;
    mainProgram = "kinome";
    platforms = [ "x86_64-linux" "aarch64-linux" ];
  };
}
