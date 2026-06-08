{ lib
, stdenv
, bun2nix
, bun
, go
, git
, zip
}:

let
  packageJson = lib.importJSON ../package.json;

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
      ]);
  };

  packageJson = ../package.json;
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = "${
      stdenv.mkDerivation {
        name = "kinome-bun-nix";
        dontUnpack = true;
        nativeBuildInputs = [ bun2nix ];
        installPhase = ''
          mkdir -p $out
          bun2nix -l ${../bun.lock} -o $out/bun.nix
        '';
      }
    }/bun.nix";
  };

  nativeBuildInputs = [ bun go git zip ];

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
    ln -s $out/libexec/kinome/kinome $out/bin/kinome

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
